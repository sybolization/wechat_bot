/** 本地冒烟测试：起服务 + 真实 HTTP 请求，覆盖 webapi / wxmp / 静态路由与 core 模块。 */
process.chdir(__dirname); // 相对路径（qaLog 的 data/、webui/）以 cloudrun/ 为基准，与 cwd 无关
process.env.PORT = "8099"; // 避免端口冲突（server 子进程继承）
process.env.STRICT_WX_ONLY = "1"; // 模拟生产严格模式（envload 不覆盖已有环境变量，本地 .env 改 0 也不影响测试）

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const assert = require("node:assert");
require("./envload"); // 测试进程同样先加载 .env（core/agent 读取 ACTIVE_KB、API key）

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const results = [];
let failed = false;

function pass(name) {
  results.push(`[PASS] ${name}`);
  console.log(`[PASS] ${name}`);
}
function fail(name, e) {
  failed = true;
  results.push(`[FAIL] ${name}`);
  console.error(`[FAIL] ${name} —— ${e.message}`);
}
async function testCase(name, fn) {
  try { await fn(); pass(name); } catch (e) { fail(name, e); }
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch { /* 未就绪，继续等 */ }
    await new Promise((s) => setTimeout(s, 100));
  }
  return false;
}

(async () => {
  const child = spawn(process.execPath, ["server.js"], { stdio: "inherit" });
  try {
    if (!(await waitServer())) throw new Error("服务启动超时（端口可能被占用）");
    results.push(`[PASS] 启动服务（PORT=${process.env.PORT}）`);
    console.log(`[PASS] 启动服务（PORT=${process.env.PORT}）`);

    // ── 1. GET /healthz ──
    await testCase("GET /healthz → 200 ok", async () => {
      const r = await fetch(`${BASE}/healthz`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await r.text(), "ok");
    });

    // ── 2. GET /api/config 关键字段 ──
    await testCase("GET /api/config 关键字段齐全", async () => {
      const r = await fetch(`${BASE}/api/config`);
      assert.strictEqual(r.status, 200);
      const c = await r.json();
      for (const k of ["title", "welcome", "suggestions", "placeholder", "disclaimer"]) {
        assert.ok(c[k], `config.${k} 缺失`);
      }
      assert.ok(Array.isArray(c.suggestions) && c.suggestions.length >= 1, "suggestions 应为非空数组");
      assert.ok(c.wx && ["appid", "env", "service"].every((k) => typeof c.wx[k] === "string"), "wx 配置缺失");
    });

    // ── 3. POST /api/ask 空 question → 400（带 openid 头通过严格模式校验后命中参数校验）──
    await testCase("POST /api/ask 空 question → 400 bad_request", async () => {
      const r = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wx-openid": "test-openid" },
        body: JSON.stringify({ question: "" }),
      });
      assert.strictEqual(r.status, 400);
      const j = await r.json();
      assert.ok(j.error && j.error.code === "bad_request", "错误结构异常: " + JSON.stringify(j));
    });

    // ── 3b. 严格模式：无 x-wx-openid 头（公网直连）→ 403 ──
    await testCase("STRICT_WX_ONLY 无 openid 直连 → 403 forbidden", async () => {
      const r = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "班车有哪些线路？" }),
      });
      assert.strictEqual(r.status, 403, `期望 403，实际 ${r.status}`);
      const j = await r.json();
      assert.ok(j.error && j.error.code === "forbidden", "错误结构异常: " + JSON.stringify(j));
      const r2 = await fetch(`${BASE}/api/reset`, { method: "POST" });
      assert.strictEqual(r2.status, 403, "reset 同样应被 403 拒绝");
    });

    // ── 4. POST /api/ask 真实问答（x-wx-openid 身份，走 DeepSeek）──
    await testCase("POST /api/ask 真实问答 → 200 且有 answer", async () => {
      const r = await fetch(`${BASE}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wx-openid": "test-openid" },
        body: JSON.stringify({ question: "班车有哪些线路？" }),
      });
      const j = await r.json();
      if (!process.env.DEEPSEEK_API_KEY) {
        assert.strictEqual(r.status, 500, "未配置 key 时应回 500");
        assert.ok(j.error && j.error.code === "internal", "错误结构异常");
        console.log("[SKIP] 未配置 DEEPSEEK_API_KEY，仅断言 500 结构");
        return;
      }
      assert.strictEqual(r.status, 200, `期望 200，实际 ${r.status}: ${JSON.stringify(j)}`);
      assert.ok(typeof j.answer === "string" && j.answer.length > 0, "answer 应为非空字符串");
    });

    // ── 5. POST /api/reset ──
    await testCase("POST /api/reset → { ok: true }", async () => {
      const r = await fetch(`${BASE}/api/reset`, {
        method: "POST",
        headers: { "x-wx-openid": "test-openid" },
      });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { ok: true });
    });

    // ── 6. POST / XML 文本私信 → 被动引导 XML ──
    await testCase("POST / 文本私信 → 引导文案 XML", async () => {
      const xml = "<xml><ToUserName><![CDATA[gh_test]]></ToUserName>" +
        "<FromUserName><![CDATA[o_user1]]></FromUserName><CreateTime>1700000000</CreateTime>" +
        "<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content></xml>";
      const r = await fetch(`${BASE}/`, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: xml,
      });
      const t = await r.text();
      assert.strictEqual(r.status, 200);
      assert.ok((r.headers.get("content-type") || "").includes("application/xml"), "应为 application/xml");
      assert.ok(t.includes("<xml>") && t.includes("<MsgType><![CDATA[text]]></MsgType>"), "应为被动文本 XML 回复");
      assert.ok(t.includes("智能问答"), "应含引导文案: " + t);
    });

    // ── 7. POST / CheckContainerPath → success ──
    await testCase("POST / CheckContainerPath → success", async () => {
      const r = await fetch(`${BASE}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CheckContainerPath" }),
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(await r.text(), "success");
    });

    // ── 8. GET / 静态页（webui 由前端并行开发，尚无 index.html 则跳过）──
    await testCase("GET / → 200 text/html", async () => {
      if (!fs.existsSync("webui/index.html")) {
        console.log("[SKIP] webui/index.html 尚未创建（前端并行开发中）");
        return;
      }
      const r = await fetch(`${BASE}/`);
      assert.strictEqual(r.status, 200);
      assert.ok((r.headers.get("content-type") || "").includes("text/html"), "应为 text/html");
    });

    // ── 9. core/agent：迁移后 docs 路径正确 + ACTIVE_KB 路由 ──
    await testCase("core/agent 迁移后 docs 路径正确（guanglian 库清单）", async () => {
      const agent = require("./core/agent");
      assert.strictEqual(agent.ACTIVE_KB, "guanglian", "默认库应为 guanglian");
      const g = await agent.readToolAsync({ path: "/" });
      assert.ok(g.includes("bus-guanglian-zhengchang-20260715.xlsx") && g.includes("7 项"),
        "guanglian 库清单异常（docs 路径可能错）:\n" + g);
    });

    // ── 10. core/qa-log：JSONL 落盘 + 字段记录 ──
    await testCase("core/qa-log JSONL 落盘", async () => {
      const { qaLog } = require("./core/qa-log");
      qaLog("test-openid", "班车几点发车？", "早班 7:30");
      const qFile = `data/qa-${new Date().toISOString().slice(0, 7)}.jsonl`;
      const rec = JSON.parse(fs.readFileSync(qFile, "utf-8").trim().split("\n").pop());
      assert.strictEqual(rec.q, "班车几点发车？", "问题未正确记录");
      assert.strictEqual(rec.openid, "test-openid", "openid 未记录");
      assert.strictEqual(rec.ok, true, "默认应为成功态");
      fs.rmSync("data", { recursive: true, force: true }); // 清理测试数据
    });

    // ── 11. core/agent 统一流式：onDelta 增量非空且聚合等于最终答案 ──
    await testCase("core/agent 流式输出（onDelta 聚合 = 最终答案）", async () => {
      if (!process.env.DEEPSEEK_API_KEY) {
        console.log("[SKIP] 未配置 DEEPSEEK_API_KEY，跳过流式用例");
        return;
      }
      const agent = require("./core/agent");
      const deltas = [];
      const answer = await agent.runAgent("光联正常班1号车的发车时间", "test-stream-openid", {
        onDelta: (piece) => deltas.push(piece),
      });
      assert.ok(typeof answer === "string" && answer.length > 0, "answer 应为非空字符串");
      assert.ok(deltas.length > 0, "应收到至少一个流式增量");
      assert.strictEqual(deltas.join("").trim(), answer, "增量聚合应与最终答案一致");
    });
  } catch (e) {
    fail("冒烟流程", e);
  } finally {
    child.kill();
  }

  console.log("\n===== 冒烟结果 =====");
  results.forEach((l) => console.log(l));
  process.exit(failed ? 1 : 0);
})();
