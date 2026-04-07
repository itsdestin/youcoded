import React, { createContext, useContext, useReducer, Dispatch } from 'react';
import { ChatAction, ChatState, SessionChatState, createSessionChatState } from './chat-types';
import { chatReducer } from './chat-reducer';

const ChatStateContext = createContext<ChatState>(new Map());
const ChatDispatchContext = createContext<Dispatch<ChatAction>>(() => {});

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, new Map() as ChatState);

  return React.createElement(
    ChatStateContext.Provider,
    { value: state },
    React.createElement(ChatDispatchContext.Provider, { value: dispatch }, children),
  );
}

export function useChatState(sessionId: string): SessionChatState {
  const state = useContext(ChatStateContext);
  return state.get(sessionId) || createSessionChatState();
}

export function useChatDispatch(): Dispatch<ChatAction> {
  return useContext(ChatDispatchContext);
}

export function useChatStateMap(): ChatState {
  return useContext(ChatStateContext);
}
