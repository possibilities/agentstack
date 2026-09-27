/**
 * Top-level blocks split at blank lines outside fences and indented
 * continuations. While text streams only the last block changes, so earlier
 * blocks keep their parsed output.
 */
export function markdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
    } else if (marker) fence = marker;
    const next = lines.slice(index + 1).find((value) => value.trim());
    if (!fence && !line.trim() && current.length && (next === undefined || !/^\s/.test(next))) {
      blocks.push(current.join("\n"));
      current = [];
      return;
    }
    if (current.length || line.trim()) current.push(line);
  });
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}
