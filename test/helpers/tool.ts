/** Extract the text content from a callTool result. */
export function toolText(result: unknown): string {
  return (((result as { content: unknown[] }).content)[0] as { text: string }).text
}

export const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms))
