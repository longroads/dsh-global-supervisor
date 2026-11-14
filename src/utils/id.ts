/**
 * ID 生成工具（node:crypto 动态导入，遵守顶层零内建静态依赖纪律）。
 */
export async function randomUUID(): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.randomUUID();
}
