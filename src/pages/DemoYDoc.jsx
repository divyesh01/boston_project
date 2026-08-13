import React from 'react';
import { YDocProvider, useYDoc } from '@/crdt';

export default function DemoYDoc() {
  return (
    <YDocProvider name="demo">
      <DemoContent />
    </YDocProvider>
  );
}

function DemoContent() {
  const doc = useYDoc();
  const map = doc.getMap('root');
  const counter = map.get('counter') ?? 0;
  const increment = () => map.set('counter', counter + 1);
  return (
    <div>
      <p>Shared counter: {counter}</p>
      <button onClick={increment}>Increment</button>
    </div>
  );
}
