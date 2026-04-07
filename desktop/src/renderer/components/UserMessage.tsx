import React from 'react';
import { ChatMessage } from '../../shared/types';
import LinkableText from './LinkableText';

interface Props {
  message: ChatMessage;
}

export default React.memo(function UserMessage({ message }: Props) {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="user-bubble max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-5 py-3 text-sm text-on-accent whitespace-pre-wrap">
        <LinkableText text={message.content} />
      </div>
    </div>
  );
});
