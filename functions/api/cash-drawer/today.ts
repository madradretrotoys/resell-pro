function renderBalanceBanner(data) {
  if (!els.balanceBanner) return;

  const expected = Number(data?.expected_now_total ?? NaN);
  const variance = Number(data?.variance_now_total ?? NaN);
  const net = Number(data?.net_since_last_count ?? NaN);

  // If we don't have a baseline snapshot yet, hide banner
  if (!Number.isFinite(expected)) {
    els.balanceBanner.classList.add('hidden');
    return;
  }

  els.balanceBanner.classList.remove('hidden');

  const hasVariance = Number.isFinite(variance) && Math.abs(variance) > 0.009;

  // Helper label for net movements
  let netLabel = '';
  if (Number.isFinite(net) && Math.abs(net) > 0.009) {
    netLabel = net > 0
      ? ` • Net movements: +$${net.toFixed(2)}`
      : ` • Net movements: -$${Math.abs(net).toFixed(2)}`;
  } else {
    netLabel = ` • Net movements: $0.00`;
  }

  if (!hasVariance) {
    // If we have a count today and it matches expected
    els.balanceBanner.textContent = `Expected now: $${expected.toFixed(2)} ✅ Balanced${netLabel}`;
    els.balanceBanner.className = 'mb-2 p-2 rounded border text-sm bg-green-50 border-green-200 text-green-800';
    return;
  }

  const label = variance > 0 ? `Over by $${variance.toFixed(2)}` : `Short by $${Math.abs(variance).toFixed(2)}`;
  const severe = Math.abs(variance) >= 5;

  els.balanceBanner.textContent = `Expected now: $${expected.toFixed(2)} • Variance: ${label}${netLabel}`;

  if (severe) {
    els.balanceBanner.className = 'mb-2 p-2 rounded border text-sm bg-red-50 border-red-200 text-red-800';
  } else {
    els.balanceBanner.className = 'mb-2 p-2 rounded border text-sm bg-yellow-50 border-yellow-200 text-yellow-800';
  }
}
