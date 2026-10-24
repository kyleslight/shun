type GalleryImage = { id: string; kind: string; mimeType?: string };
type GalleryTurn<T> = {
  attachments?: T[];
  timeline?: Array<{ type: string; tool?: { attachments?: T[] } }>;
  tools?: Array<{ attachments?: T[] }>;
};

export function conversationImages<T extends GalleryImage>(turns: GalleryTurn<T>[]): T[] {
  const images: T[] = [], seen = new Set<string>();
  const add = (item: T) => {
    if (seen.has(item.id) || (item.kind !== 'image' && !item.mimeType?.startsWith('image/'))) return;
    seen.add(item.id);
    images.push(item);
  };
  for (const turn of turns) {
    turn.attachments?.forEach(add);
    for (const entry of turn.timeline || []) {
      if (entry.type === 'tool') entry.tool?.attachments?.forEach(add);
    }
    for (const tool of turn.tools || []) tool.attachments?.forEach(add);
  }
  return images;
}
