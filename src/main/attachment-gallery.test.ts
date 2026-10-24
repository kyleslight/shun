import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationImages } from '../renderer/src/attachment-gallery.ts';

const image = (id: string) => ({ id, kind: 'image' });

test('conversation gallery orders uploads and tool images across turns, skipping documents and duplicates', () => {
  const first = image('upload'), second = image('tool'), third = image('next-turn');
  assert.deepEqual(conversationImages([
    { attachments: [first, { id: 'document', kind: 'pdf' }], timeline: [
      { type: 'text' },
      { type: 'tool', tool: { attachments: [second, first] } },
    ], tools: [{ attachments: [second] }] },
    { attachments: [third] },
  ]), [first, second, third]);
});

test('conversation gallery includes tool images from turns without a timeline', () => {
  const screenshot = image('screenshot');
  assert.deepEqual(conversationImages([{ tools: [{ attachments: [screenshot] }] }]), [screenshot]);
  assert.deepEqual(conversationImages([]), []);
});

test('conversation gallery recognizes image MIME types from remote attachments', () => {
  const screenshot = { id: 'remote', kind: 'media', mimeType: 'image/png' };
  assert.deepEqual(conversationImages([{ attachments: [screenshot] }]), [screenshot]);
});
