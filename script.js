// ==========================
// 設定
// ==========================
const API_URL =
 "https://sousakubu-origami-r8-1-do.shirokuma0822.workers.dev/api/materials";
const AUTO_UPDATE_INTERVAL = 30;
let materials = [];

// サーバーから最後に取得・同期した状態。
// 保存時は全配列をPUTせず、変更された材料だけPATCHする。
let syncedMaterials = new Map();

// 自動更新・最終更新表示用
let lastUpdateTimestamp = null;
let nextAutoUpdateTimestamp = Date.now() + AUTO_UPDATE_INTERVAL * 1000;
let autoUpdateRunning = false;

// ==========================
// DOM
// ==========================
const $ = (id) => document.getElementById(id);
const dom = {
 container: $("materials"),
 template: $("materialTemplate"),
 totalRequired: $("totalRequired"),
 totalPrepared: $("totalPrepared"),
 totalRemaining: $("totalRemaining"),
 overallBar: $("overallBar"),
 overallPercent: $("overallPercent"),
 loading: $("loading"),
 lastUpdate: $("lastUpdate"),
 autoUpdateCountdown: $("autoUpdateCountdown"),
};

// ==========================
// Utility
// ==========================
function showLoading(show) {
 dom.loading.style.display = show ? "flex" : "none";
}

function toast(text) {
 const t = $("toast");
 t.textContent = text;
 t.classList.add("show");
 setTimeout(() => {
   t.classList.remove("show");
 }, 2000);
}

function nowString() {
 return new Date().toLocaleString("ja-JP");
}

function markUpdated() {
 lastUpdateTimestamp = Date.now();
 updateStatusDisplay();
}

function isInputFocused() {
 const active = document.activeElement;
 if (!active) return false;

 return (
   active.tagName === "INPUT" ||
   active.tagName === "TEXTAREA" ||
   active.tagName === "SELECT"
 );
}

function updateStatusDisplay() {
 const now = Date.now();

 if (lastUpdateTimestamp === null) {
   dom.lastUpdate.textContent = "最終更新：---";
 } else {
   const secondsAgo = Math.max(
     0,
     Math.floor((now - lastUpdateTimestamp) / 1000)
   );
   dom.lastUpdate.textContent =
     `最終更新：${new Date(lastUpdateTimestamp).toLocaleString("ja-JP")}（${secondsAgo}秒前）`;
 }

 if (isInputFocused()) {
   dom.autoUpdateCountdown.textContent = "自動更新：入力中のため停止";
   return;
 }

 const secondsUntilUpdate = Math.max(
   0,
   Math.ceil((nextAutoUpdateTimestamp - now) / 1000)
 );

 dom.autoUpdateCountdown.textContent =
   `次回自動更新まで：${secondsUntilUpdate}秒`;
}

function scheduleNextAutoUpdate() {
 nextAutoUpdateTimestamp = Date.now() + AUTO_UPDATE_INTERVAL * 1000;
 updateStatusDisplay();
}

function cloneMaterial(material) {
 return {
   id: material.id,
   name: material.name,
   required: Number(material.required),
   prepared: Number(material.prepared),
 };
}

function rememberSynced(materialList) {
 syncedMaterials = new Map(
   materialList.map((material) => [material.id, cloneMaterial(material)])
 );
}

function buildPatch(material) {
 const previous = syncedMaterials.get(material.id);
 if (!previous) return cloneMaterial(material);

 const patch = {};

 if (material.name !== previous.name) {
   patch.name = material.name;
 }
 if (Number(material.required) !== Number(previous.required)) {
   patch.required = Number(material.required);
 }
 if (Number(material.prepared) !== Number(previous.prepared)) {
   patch.prepared = Number(material.prepared);
 }

 return patch;
}

// ==========================
// LocalStorage
// ==========================
function saveLocal() {
 localStorage.setItem("materials", JSON.stringify(materials));
}

function loadLocal() {
 const text = localStorage.getItem("materials");
 if (!text) return;

 try {
   const parsed = JSON.parse(text);
   if (Array.isArray(parsed)) {
     materials = parsed;
   }
 } catch {
   materials = [];
 }
}

// ==========================
// API
// ==========================
async function request(url, options = {}) {
 const res = await fetch(url, {
   ...options,
   headers: {
     "Content-Type": "application/json",
     ...(options.headers || {}),
   },
 });

 const data = await res.json().catch(() => null);

 if (!res.ok) {
   throw new Error(data?.error || `通信失敗 (${res.status})`);
 }

 return data;
}

async function loadMaterials() {
 if (autoUpdateRunning) return;
 autoUpdateRunning = true;
 showLoading(true);

 try {
   const data = await request(API_URL, {
     method: "GET",
     cache: "no-store",
   });

   if (!Array.isArray(data)) {
     throw new Error("サーバーから不正なデータが返されました");
   }

   materials = data;
   rememberSynced(materials);
   saveLocal();
   render();

   markUpdated();
   scheduleNextAutoUpdate();
 } catch (e) {
   console.error(e);
   toast(e.message || "読み込み失敗");
 } finally {
   showLoading(false);
   autoUpdateRunning = false;
 }
}

// 材料1件だけをDurable Objectへ原子的にPATCHする。
// 他の端末が別の材料を変更していても、全配列PUTで上書きしない。
async function updateMaterialOnServer(material) {
 const patch = buildPatch(material);

 if (Object.keys(patch).length === 0) {
   return true;
 }

 const data = await request(
   API_URL + "/" + encodeURIComponent(material.id),
   {
     method: "PATCH",
     body: JSON.stringify(patch),
   }
 );

 if (!Array.isArray(data)) {
   throw new Error("サーバーから不正なデータが返されました");
 }

 // PATCH後はサーバーの正規化結果を現在値へ反映する。
 const serverMaterial = data.find((item) => item.id === material.id);

 if (serverMaterial) {
   Object.assign(material, serverMaterial);
 }

 materials = data;
 rememberSynced(materials);
 saveLocal();

 return true;
}

async function saveMaterials() {
 try {
   const changed = materials.filter(
     (material) => Object.keys(buildPatch(material)).length > 0
   );

   if (changed.length === 0) {
     markUpdated();
     return true;
   }

   showLoading(true);

   // 各材料を個別PATCH。
   // Durable Object側では各更新が1回ずつ直列化される。
   for (const material of changed) {
     await updateMaterialOnServer(material);
   }

   markUpdated();
   scheduleNextAutoUpdate();
   return true;
 } catch (e) {
   console.error(e);
   toast(e.message || "保存失敗");
   return false;
 } finally {
   showLoading(false);
 }
}

// ==========================
// 集計
// ==========================
function updateSummary() {
 let required = 0;
 let prepared = 0;

 materials.forEach((m) => {
   required += Number(m.required);
   prepared += Number(m.prepared);
 });

 const remain = Math.max(required - prepared, 0);

 dom.totalRequired.textContent = required;
 dom.totalPrepared.textContent = prepared;
 dom.totalRemaining.textContent = remain;

 const p = required === 0 ? 0 : (prepared / required) * 100;

 dom.overallBar.style.width = p + "%";
 dom.overallPercent.textContent = p.toFixed(1) + "%";
}

// ==========================
// 描画
// ==========================
function render() {
 dom.container.innerHTML = "";

 materials.forEach((material) => {
   const card = dom.template.content.firstElementChild.cloneNode(true);

   const name = card.querySelector(".material-name");
   const required = card.querySelector(".required");
   const prepared = card.querySelector(".prepared");
   const addCount = card.querySelector(".add-count");
   const addButton = card.querySelector(".add-button");
   const remaining = card.querySelector(".remaining");
   const bar = card.querySelector(".progress-bar");
   const percent = card.querySelector(".percent");

   name.value = material.name || "";
   required.value = material.required || 0;
   prepared.value = material.prepared || 0;

   function refresh() {
     material.name = name.value;
     material.required = Math.max(0, Number(required.value));

     // 表示上もrequiredを超えないようにする。
     material.prepared = Math.max(0, Number(material.prepared));

     if (material.prepared > material.required) {
       material.prepared = material.required;
       prepared.value = material.prepared;
     }

     const remain = material.required - material.prepared;
     remaining.value = remain;

     const p =
       material.required === 0
         ? 0
         : (material.prepared / material.required) * 100;

     percent.textContent = p.toFixed(1) + "%";
     bar.style.width = p + "%";

     updateSummary();
   }

   refresh();

   name.addEventListener("input", refresh);

   required.addEventListener("input", () => {
     material.required = Math.max(0, Number(required.value));

     if (material.prepared > material.required) {
       material.prepared = material.required;
       prepared.value = material.prepared;
     }

     refresh();
   });

   prepared.addEventListener("input", () => {
     material.prepared = Math.max(0, Number(prepared.value));
     refresh();
   });

   // 入力欄の変更は、この材料だけをPATCH。
   function autoSave() {
     clearTimeout(window.saveTimer);

     window.saveTimer = setTimeout(async () => {
       try {
         await updateMaterialOnServer(material);
         markUpdated();
         scheduleNextAutoUpdate();
       } catch (e) {
         console.error(e);
         toast(e.message || "自動保存失敗");
       }
     }, 500);
   }

   name.addEventListener("change", autoSave);
   required.addEventListener("change", autoSave);
   prepared.addEventListener("change", autoSave);

   // ＋/−はDurable Object側のSQL UPDATEで原子的に処理。
   addButton.onclick = async () => {
     const amount = Number(addCount.value);

     if (!Number.isInteger(amount) || amount === 0) {
       toast("追加数を入力してください");
       return;
     }

     addButton.disabled = true;

     try {
       const data = await request(API_URL + "/add", {
         method: "POST",
         body: JSON.stringify({
           id: material.id,
           amount,
         }),
       });

       if (!Array.isArray(data)) {
         throw new Error("サーバーから不正なデータが返されました");
       }

       materials = data;
       rememberSynced(materials);
       saveLocal();

       addCount.value = "";
       render();

       markUpdated();
       scheduleNextAutoUpdate();

       toast(
         amount > 0
           ? `${amount}個追加しました`
           : `${Math.abs(amount)}個減らしました`
       );
     } catch (e) {
       console.error(e);
       toast(e.message || "通信エラー");
     } finally {
       addButton.disabled = false;
     }
   };

   dom.container.appendChild(card);
 });

 updateSummary();
}

// ==========================
// 材料追加
// ==========================
// 材料追加もローカル配列へ先に追加せず、
// Durable ObjectのPOSTでサーバー側を先に更新する。
async function addMaterial() {
 try {
   showLoading(true);

   const data = await request(API_URL, {
     method: "POST",
     body: JSON.stringify({
       id: crypto.randomUUID(),
       name: "新しい材料",
       required: 0,
       prepared: 0,
     }),
   });

   if (!Array.isArray(data)) {
     throw new Error("サーバーから不正なデータが返されました");
   }

   materials = data;
   rememberSynced(materials);
   saveLocal();
   render();

   markUpdated();
   scheduleNextAutoUpdate();
   toast("材料を追加しました");
 } catch (e) {
   console.error(e);
   toast(e.message || "材料の追加に失敗しました");
 } finally {
   showLoading(false);
 }
}

// ==========================
// 検索
// ==========================
$("search").addEventListener("input", (e) => {
 const keyword = e.target.value.toLowerCase();

 document.querySelectorAll(".material-card").forEach((card) => {
   const name = card
     .querySelector(".material-name")
     .value
     .toLowerCase();

   card.style.display = name.includes(keyword) ? "" : "none";
 });
});

// ==========================
// ボタン
// ==========================
// $("addMaterial").onclick = addMaterial;

$("refresh").onclick = () => {
 loadMaterials();
};

$("save").onclick = async () => {
 const ok = await saveMaterials();

 if (ok) {
   toast("保存しました");
 }
};

// ==========================
// オンライン状態
// ==========================
function updateConnection() {
 let el = document.getElementById("connectionStatus");

 if (!el) {
   el = document.createElement("div");
   el.id = "connectionStatus";
   document.body.appendChild(el);
 }

 if (navigator.onLine) {
   el.textContent = "🟢 オンライン";
   el.style.background = "#2e7d32";
 } else {
   el.textContent = "🔴 オフライン";
   el.style.background = "#c62828";
 }
}

window.addEventListener("online", () => {
 updateConnection();
 loadMaterials();
});

window.addEventListener("offline", updateConnection);

// ==========================
// Ctrl+S
// ==========================
document.addEventListener("keydown", (e) => {
 if (e.ctrlKey && e.key === "s") {
   e.preventDefault();

   saveMaterials().then((ok) => {
     if (ok) toast("保存しました");
   });
 }
});

// ==========================
// 自動同期
// ==========================
// 入力中にサーバーから再取得すると、
// 入力途中の内容がrender()で上書きされる可能性があるため、
// いずれかの入力欄にフォーカスがある間は自動更新しない。
setInterval(() => {
 if (!navigator.onLine || isInputFocused()) {
   updateStatusDisplay();
   return;
 }

 if (Date.now() >= nextAutoUpdateTimestamp) {
   loadMaterials();
 } else {
   updateStatusDisplay();
 }
}, 1000);

// ==========================
// 完了チェック
// ==========================
function checkCompleted() {
 if (materials.length === 0) return;

 const complete = materials.every(
   (m) => m.prepared >= m.required
 );

 if (complete) {
   toast("🎉 全て準備完了！");
 }
}

// ==========================
// 初期化
// ==========================
loadLocal();

if (materials.length) {
 render();
}

updateConnection();
updateStatusDisplay();
loadMaterials();
