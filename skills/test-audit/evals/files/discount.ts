export function discount(total: number, code: string | undefined): number {
  if (code === undefined) return total;
  if (code === "HALF") return total / 2;
  if (total < 10) return total;
  return total - 5;
}
