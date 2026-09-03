// exportCsv.mjs — W31-I1: generación CSV de transacciones (función pura).
// Formato: fecha,descripcion,monto,moneda,cuenta,categoria
// descripcion y categoria van entre comillas dobles; las comillas internas
// se escapan duplicándolas (RFC 4180). Sin dependencias externas.

const CSV_HEADERS = "fecha,descripcion,monto,moneda,cuenta,categoria";

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function toCsv(transactions, accounts) {
  const accountNames = new Map(
    (Array.isArray(accounts) ? accounts : []).map((a) => [a.id, a.name])
  );
  const lines = [CSV_HEADERS];
  for (const t of Array.isArray(transactions) ? transactions : []) {
    const cuenta = accountNames.get(t.accountId) ?? t.accountId ?? "";
    lines.push(
      [
        t.date ?? "",
        csvEscape(t.description ?? ""),
        String(t.amount ?? 0),
        t.currency ?? "",
        cuenta,
        csvEscape(t.category ?? ""),
      ].join(",")
    );
  }
  return lines.join("\n");
}
