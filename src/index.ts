import { DurableObject } from "cloudflare:workers";

type Material = {
	id: string;
	name: string;
	required: number;
	prepared: number;
};

type MaterialPatch = Partial<Material>;

const MAIN_DO_NAME = "main";

function normalizeMaterial(input: unknown): Material {
	if (!input || typeof input !== "object") throw new Error("材料データが不正です");
	const value = input as Record<string, unknown>;
	const id = String(value.id ?? "").trim();
	const name = String(value.name ?? "").trim();
	const required = Number(value.required);
	const prepared = Number(value.prepared ?? 0);
	if (!id) throw new Error("idは必須です");
	if (!name) throw new Error("nameは必須です");
	if (!Number.isInteger(required) || required < 0) throw new Error("requiredは0以上の整数にしてください");
	if (!Number.isInteger(prepared) || prepared < 0) throw new Error("preparedは0以上の整数にしてください");
	return { id, name, required, prepared: Math.min(prepared, required) };
}

function normalizePatch(input: unknown): MaterialPatch {
	if (!input || typeof input !== "object") throw new Error("更新データが不正です");
	const value = input as Record<string, unknown>;
	const patch: MaterialPatch = {};

	if ("name" in value) {
		const name = String(value.name ?? "").trim();
		if (!name) throw new Error("nameは必須です");
		patch.name = name;
	}
	if ("required" in value) {
		const required = Number(value.required);
		if (!Number.isInteger(required) || required < 0) throw new Error("requiredは0以上の整数にしてください");
		patch.required = required;
	}
	if ("prepared" in value) {
		const prepared = Number(value.prepared);
		if (!Number.isInteger(prepared) || prepared < 0) throw new Error("preparedは0以上の整数にしてください");
		patch.prepared = prepared;
	}

	if (Object.keys(patch).length === 0) throw new Error("更新する項目がありません");
	return patch;
}

export class MyDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS materials (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				required INTEGER NOT NULL DEFAULT 0,
				prepared INTEGER NOT NULL DEFAULT 0,
				sort_order INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	getMaterials(): Material[] {
		return this.ctx.storage.sql
			.exec(`SELECT id, name, required, prepared FROM materials ORDER BY sort_order ASC, created_at ASC`)
			.toArray() as Material[];
	}

	replaceMaterials(input: unknown[]): void {
		const materials = input.map(normalizeMaterial);
		const now = Date.now();

		// Durable ObjectsではSQLのBEGIN/COMMITではなく、transactionSync()を使う。
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM materials");
			for (let i = 0; i < materials.length; i++) {
				const material = materials[i];
				this.ctx.storage.sql.exec(
					`INSERT INTO materials
					 (id, name, required, prepared, sort_order, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					material.id,
					material.name,
					material.required,
					material.prepared,
					i,
					now,
					now,
				);
			}
		});
	}

	addMaterial(input: unknown): Material[] {
		const material = normalizeMaterial(input);
		const now = Date.now();
		const nextOrder = this.ctx.storage.sql
			.exec("SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM materials")
			.one() as { next_order: number };

		this.ctx.storage.sql.exec(
			`INSERT INTO materials
			 (id, name, required, prepared, sort_order, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			material.id, material.name, material.required, material.prepared,
			nextOrder.next_order, now, now,
		);
		return this.getMaterials();
	}

	updateMaterial(id: string, input: unknown): Material[] {
		const materialId = String(id ?? "").trim();
		if (!materialId) throw new Error("idは必須です");
		const patch = normalizePatch(input);
		const now = Date.now();

		this.ctx.storage.transactionSync(() => {
			const current = this.ctx.storage.sql
				.exec("SELECT required, prepared FROM materials WHERE id = ?", materialId)
				.one() as { required?: number; prepared?: number } | null;
			if (!current || current.required === undefined || current.prepared === undefined) {
				throw new Error("指定された材料が見つかりません");
			}

			const required = patch.required ?? current.required;
			const prepared = Math.min(patch.prepared ?? current.prepared, required);
			if (patch.name !== undefined && patch.required !== undefined && patch.prepared === undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET name = ?, required = ?, prepared = ?, updated_at = ? WHERE id = ?",
					patch.name, required, prepared, now, materialId,
				);
			} else if (patch.name !== undefined && patch.required === undefined && patch.prepared !== undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET name = ?, prepared = ?, updated_at = ? WHERE id = ?",
					patch.name, prepared, now, materialId,
				);
			} else if (patch.name !== undefined && patch.required === undefined && patch.prepared === undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET name = ?, updated_at = ? WHERE id = ?",
					patch.name, now, materialId,
				);
			} else if (patch.required !== undefined && patch.prepared !== undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET required = ?, prepared = ?, updated_at = ? WHERE id = ?",
					required, prepared, now, materialId,
				);
			} else if (patch.required !== undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET required = ?, prepared = ?, updated_at = ? WHERE id = ?",
					required, prepared, now, materialId,
				);
			} else if (patch.prepared !== undefined) {
				this.ctx.storage.sql.exec(
					"UPDATE materials SET prepared = ?, updated_at = ? WHERE id = ?",
					prepared, now, materialId,
				);
			}
		});

		return this.getMaterials();
	}

	deleteMaterial(id: string): Material[] {
		const materialId = String(id ?? "").trim();
		if (!materialId) throw new Error("idは必須です");
		const result = this.ctx.storage.sql.exec("DELETE FROM materials WHERE id = ?", materialId);
		if (result.rowsWritten === 0) throw new Error("指定された材料が見つかりません");
		return this.getMaterials();
	}

	addPrepared(id: string, amount: number): Material[] {
		const materialId = String(id ?? "").trim();
		if (!materialId) throw new Error("idは必須です");
		if (!Number.isInteger(amount) || amount === 0) throw new Error("amountは0ではない整数にしてください");

		this.ctx.storage.sql.exec(
			`UPDATE materials
			 SET prepared = MAX(0, MIN(required, prepared + ?)), updated_at = ?
			 WHERE id = ?`,
			amount, Date.now(), materialId,
		);

		const result = this.ctx.storage.sql.exec("SELECT id FROM materials WHERE id = ?", materialId).one() as { id?: string } | null;
		if (!result?.id) throw new Error("指定された材料が見つかりません");
		return this.getMaterials();
	}
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=UTF-8",
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
}

function errorResponse(message: string, status = 400): Response {
	return jsonResponse({ error: message }, status);
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			} });
		}

		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/materials")) {
			return new Response("創作部 材料管理システム API", { headers: { "Access-Control-Allow-Origin": "*" } });
		}

		const id = env.MY_DURABLE_OBJECT.idFromName(MAIN_DO_NAME);
		const stub = env.MY_DURABLE_OBJECT.get(id);

		try {
			if (url.pathname === "/api/materials" && request.method === "GET") {
				return jsonResponse(await stub.getMaterials());
			}
			if (url.pathname === "/api/materials" && request.method === "PUT") {
				const body = await request.json();
				if (!Array.isArray(body)) return errorResponse("配列データを送信してください");
				await stub.replaceMaterials(body);
				return jsonResponse(await stub.getMaterials());
			}
			if (url.pathname === "/api/materials" && request.method === "POST") {
				return jsonResponse(await stub.addMaterial(await request.json()), 201);
			}
			if (url.pathname.startsWith("/api/materials/") && request.method === "PATCH") {
				const materialId = decodeURIComponent(url.pathname.slice("/api/materials/".length));
				if (!materialId || materialId === "add") return errorResponse("材料IDが不正です");
				return jsonResponse(await stub.updateMaterial(materialId, await request.json()));
			}
			if (url.pathname.startsWith("/api/materials/") && request.method === "DELETE") {
				const materialId = decodeURIComponent(url.pathname.slice("/api/materials/".length));
				if (!materialId || materialId === "add") return errorResponse("材料IDが不正です");
				return jsonResponse(await stub.deleteMaterial(materialId));
			}
			if (url.pathname === "/api/materials/add" && request.method === "POST") {
				const body = await request.json() as { id?: unknown; amount?: unknown };
				return jsonResponse(await stub.addPrepared(String(body.id ?? ""), Number(body.amount)));
			}
			return errorResponse("Not Found", 404);
		} catch (error) {
			const message = error instanceof Error ? error.message : "サーバーエラーが発生しました";
			return errorResponse(message, message.includes("見つかりません") ? 404 : 400);
		}
	},
} satisfies ExportedHandler<Env>;
