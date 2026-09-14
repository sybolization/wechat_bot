/**
 * 转人工拦截：暂未接入人工客服，转人工诉求统一回复招聘咨询电话。
 * - 请求侧：isHandoffRequest() 命中则不调用 agent，直接回 HANDOFF_REPLY
 * - 出口侧：applyHandoff() 将 agent 兜底话术（规则7"转人工"）整体替换为电话指引
 */

const HANDOFF_PATTERN = /转(接)?人工|人工(客服|服务|接听)|找(个)?人工|转(接)?客服/;

const HANDOFF_REPLY = [
  "这个问题我暂时没有相关信息。如需人工咨询，请致电：",
  "校招&专业人才招聘咨询：0756-8687897",
  "生产运营岗位招聘咨询：0756-8687266",
].join("\n");

/** 用户消息是否为转人工诉求。 */
function isHandoffRequest(text) {
  return HANDOFF_PATTERN.test(String(text || ""));
}

/** agent 回答若含"转人工"兜底话术，整体替换为电话指引。 */
function applyHandoff(answer) {
  return /转人工/.test(String(answer || "")) ? HANDOFF_REPLY : answer;
}

module.exports = { isHandoffRequest, applyHandoff, HANDOFF_REPLY };
