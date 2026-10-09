const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai",
});
export function time(value: number | null | undefined) {
  return value ? timeFormatter.format(value) : "—";
}
