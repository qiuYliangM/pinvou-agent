// 代码模块原生（品悟 Engine）会话车道的薄适配层。
//
// 实现已上提为会话作用域原语 ../conversation/session-conversation.js（单会话
// 对话状态 + 会话作用域 store）与 ../conversation/useSessionConversation.js
// （React 事件订阅绑定）；本文件只保留原生车道语义的命名再导出，供既有调用方
// 与回归测试（tests/code_native_lane.test.mjs）继续使用。新代码请直接消费
// session-conversation 原语。
//
// ACP 会话由后端维护 timeline（get_codex_acp_timeline）；原生会话复用主聊天的
// engine 链路：chat 命令发消息、`chat:*` 事件推进、SavedSession messages 落盘。
// 渲染统一走 projectNativeLane → ConversationTimeline。

export {
  createConversationState as createNativeLane,
  applyChatEvent as applyNativeChatEvent,
  appendLocalUserMessage,
  removeLocalUserMessage,
  hydrateConversation as hydrateNativeLane,
  projectConversation as projectNativeLane,
} from '../conversation/session-conversation.js';
