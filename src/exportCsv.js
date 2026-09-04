export function toCsv(transactions, accounts) {
  const accountNames = new Map(
    (Array.isArray(accounts) ? accounts : []).map((a) => [String(a?.id ?? ""), String(a?.name ?? "")])
  );
  const escape = (value) => String(value ?? "").replace(/"/g, '""');
  const lines = ["fecha,descripcion,monto,moneda,cuenta,categoria"];
  for (const tx of Array.isArray(transactions) ? transactions : []) {
    const accountName = accountNames.get(String(tx?.accountId ?? "")) ?? String(tx?.accountId ?? "");
    lines.push(
      [
        String(tx?.date ?? ""),
        `"${escape(tx?.description)}"`,
        String(tx?.amount ?? 0),
        String(tx?.currency ?? ""),
        accountName,
        `"${escape(tx?.category)}"`,
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}
