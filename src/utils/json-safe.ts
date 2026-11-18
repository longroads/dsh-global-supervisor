/**
 * FB-14：工具输出/入库文本的 JSON 安全清洗。
 * DSH 宿主用 lossless JSON 校验工具返回值——汇报文本中混入的控制字符
 * （终端转义序列、二进制碎片）或孤立代理项（错误解码产物）会令整个工具调用失败。
 * 入库侧（协议 parse）与出库侧（task_report 输出）双层应用。
 */

/** 截断标记（清洗后超出上限时拼接，机器可识别）。 */
const TRUNCATION_SUFFIX = '…[truncated]';

/** 控制字符（保留 \t \n \r；含 DEL \x7F 与 C1 区 \x80-\x9F）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

/** ANSI 转义序列：CSI（颜色/光标，\x1b[31m 等）与 OSC（终端标题，\x1b]0;...\x07）。 */
const ANSI_SEQUENCES = /(?:\u001B\[[0-9;?]*[ -/]*[@-~])|(?:\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;

/** 孤立 UTF-16 代理项（高低位必须成对，孤立者无法合法序列化）。 */
const LONE_SURROGATES = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g;

/**
 * 清洗单段文本：剥 ANSI 转义序列、去控制字符、孤立代理项替换为 U+FFFD，超长截断。
 * maxLen 省略时不截断。
 */
export function sanitizeText(text: string, maxLen?: number): string {
  let cleaned = text
    .replace(ANSI_SEQUENCES, '')
    .replace(CONTROL_CHARS, '')
    .replace(LONE_SURROGATES, '\uFFFD');
  if (maxLen !== undefined && cleaned.length > maxLen) {
    cleaned = `${cleaned.slice(0, maxLen)}${TRUNCATION_SUFFIX}`;
  }
  return cleaned;
}

/** 递归深度上限（防御异常嵌套结构，正常任务详情远低于此）。 */
const MAX_DEPTH = 8;

/** 单字段截断上限（出库侧兜底；入库侧已按字段精确截断）。 */
const FIELD_MAX_LEN = 8000;

/**
 * 出库侧深度清洗：对象/数组递归、字符串字段 sanitize + 截断。
 * 用于工具返回兜底——历史脏数据（清洗上线前入库）同样被拦截。
 */
export function jsonSafeDeep<T>(value: T, depth = 0): T {
  if (depth >= MAX_DEPTH) return value;
  if (typeof value === 'string') return sanitizeText(value, FIELD_MAX_LEN) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => jsonSafeDeep(item, depth + 1)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[sanitizeText(key, 200)] = jsonSafeDeep(item, depth + 1);
    }
    return result as unknown as T;
  }
  return value;
}
