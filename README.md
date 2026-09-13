# 創作部 材料管理システム — Durable Objects版

創作部の材料在庫をCloudflare Durable Objects + SQLiteで管理するバックエンドです。

## 構成

```text
ローカルHTML
    ↓ HTTPS
Cloudflare Worker
    ↓ RPC
Durable Object（固定名: main）
    ↓
SQLite
```

Durable Objectを1つの共有ルームとして使い、材料データをDO内のSQLiteで一元管理します。

## API

Base URL:

`https://sousakubu-origami-r8-1-do.shirokuma0822.workers.dev`

### `GET /api/materials`

現在の材料一覧を取得します。

### `POST /api/materials`

材料をサーバー側で新規作成します。

```json
{
  "id": "uuid",
  "name": "折り紙（青）",
  "required": 100,
  "prepared": 20
}
```

### `POST /api/materials/add`

準備済み数を原子的に増減します。`amount` は正なら追加、負なら減少です。

```json
{
  "id": "uuid",
  "amount": 5
}
```

SQLite側では1回のUPDATEとして処理し、`0 <= prepared <= required` をサーバー側で保証します。

### `PATCH /api/materials/:id`

材料1件だけを更新します。指定した項目だけが変更されます。

```json
{
  "name": "折り紙（青・新）",
  "required": 120
}
```

複数端末で使う場合、全材料をPUTするよりもこちらを使うことで、別の材料への変更を不用意に上書きしにくくなります。

### `DELETE /api/materials/:id`

材料1件をサーバー側から削除します。

### `PUT /api/materials`

従来版との互換性のため残しています。材料配列全体を置き換えるため、複数端末での通常操作には `PATCH` を推奨します。

## Durable Objectsを活用しているポイント

- **単一のDOに状態を集約**し、同じ材料データへの操作を直列化
- **SQLite**をDO内の永続ストレージとして利用
- 準備数の増減を**サーバー側の原子的なSQL UPDATE**で処理
- 材料1件の編集を**PATCH**で行い、全配列PUTへの依存を縮小
- 複数端末からの同時操作を想定した設計
- `transactionSync()` により複数SQL処理をまとめて原子的に実行

## 開発

```bash
npm install
npm run dev
```

本番デプロイ:

```bash
npm run deploy
```

デプロイ後は、ローカルHTMLの `script.js` に設定されているAPI URLが実際のWorker URLと一致していることを確認してください。
