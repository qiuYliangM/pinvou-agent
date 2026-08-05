// 会话作用域对话状态机的 React 绑定：挂 chat:* 事件订阅（经 session-conversation
// store 按 sessionId 过滤），以版本号驱动重渲染。
//
// 使用方持有返回的 store 与 version：状态本体是可变对象（与 bridge 的 chatItems
// 同一风格），version 是内容变化的版本号，投影/渲染记忆化以 version 为依赖。
// 事件侧的视图策略（是否 bump、turn 边界联动）经 onChatEvent 回调交还给调用方。

import { useEffect, useRef, useState } from 'react';
import { listenTauri } from '../../platform/tauri/client.js';
import { createSessionConversationStore, SESSION_CHAT_EVENTS } from './session-conversation.js';

export function useSessionConversation({ onChatEvent } = {}) {
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = createSessionConversationStore();
  const store = storeRef.current;
  const [version, setVersion] = useState(0);
  const onChatEventRef = useRef(onChatEvent);
  onChatEventRef.current = onChatEvent;

  // engine chat 事件 → store（按受管理 sessionId 过滤）；订阅一次，随组件卸载。
  useEffect(() => {
    let disposed = false;
    let unlisteners = [];
    Promise.all(SESSION_CHAT_EVENTS.map(name => listenTauri(name, message => {
      const payload = (message && message.payload) || {};
      const result = store.handleChatEvent(name, payload);
      if (onChatEventRef.current) onChatEventRef.current(name, payload, result);
    }))).then(fns => {
      if (disposed) fns.forEach(fn => fn());
      else unlisteners = fns;
    }).catch(error => console.warn('[session-conversation] chat events unavailable', error));
    return () => {
      disposed = true;
      unlisteners.forEach(fn => fn());
    };
  }, [store]);

  return {
    store,
    version,
    bumpVersion: () => setVersion(current => current + 1),
  };
}
