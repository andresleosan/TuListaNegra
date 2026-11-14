-- Deudores cuyo saldo guardado no coincide con la suma de sus movimientos confirmados. Debe devolver 0 filas.
SELECT d.id, d.business_id, d.unique_code, d.current_balance_cop AS saldo_guardado,
  COALESCE(SUM(CASE WHEN m.type IN ('FIADO', 'AJUSTE_SUMA') THEN m.amount_cop ELSE -m.amount_cop END), 0) AS saldo_calculado
FROM debtors d
LEFT JOIN ledger_transactions m ON m.debtor_id = d.id AND m.business_id = d.business_id AND m.status = 'CONFIRMADO'
GROUP BY d.id
HAVING saldo_guardado <> saldo_calculado
