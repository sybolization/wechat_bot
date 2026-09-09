/** 问答记录（供离线归类分析：先攒真实问题，再据此分类文档、打标签、定替换规则）。 */
// 双通道：结构化日志（云端控制台可检索导出，留存约7天）+ 容器内 JSONL（按月分文件）。
// 注意：重新发布容器会清空 JSONL，长期留存需定期从日志或文件导出。

const fs = require("node:fs");

const QA_DIR = "data";

function qaLog(openid, question, answer, ok = true) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      openid,
      q: String(question).slice(0, 200),
      a: String(answer).slice(0, 600),
      ok,
    };
    fs.mkdirSync(QA_DIR, { recursive: true });
    fs.appendFileSync(`${QA_DIR}/qa-${rec.ts.slice(0, 7)}.jsonl`, JSON.stringify(rec) + "\n");
    console.log("[qa]", JSON.stringify(rec));
  } catch (e) {
    console.error("问答记录失败:", e.message);
  }
}

module.exports = { qaLog };
