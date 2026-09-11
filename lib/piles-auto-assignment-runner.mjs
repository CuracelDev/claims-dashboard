const MONTHS = new Set(['All', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const RUN_SOURCES = new Set(['manual', 'schedule', 'readiness', 'recovery']);

function text(value) {
  return String(value ?? '').trim();
}

function normalizeMonths(value) {
  const items = Array.isArray(value) ? value : [value || 'All'];
  const months = [...new Set(items.map(text).filter(Boolean))];
  if (!months.length || months.some((month) => !MONTHS.has(month))) {
    throw new Error('Months must contain only All or three-letter month labels.');
  }
  return months.includes('All') ? ['All'] : months;
}

export function validateRunRequest(body = {}) {
  const runAll = Boolean(body.run_all);
  const insurerName = text(body.insurer_name);
  if (!runAll && !insurerName) throw new Error('Choose an insurer or run all active insurers.');
  if (insurerName.length > 160) throw new Error('Insurer name is too long.');

  const portalEnvironment = text(body.portal_environment).toLowerCase() || 'production';
  if (!['production', 'test'].includes(portalEnvironment)) throw new Error('Portal environment must be production or test.');
  const year = text(body.year) || 'All';
  if (year !== 'All' && !/^20\d{2}$/.test(year)) throw new Error('Year must be All or a four-digit year.');
  const effectiveDate = text(body.effective_date);
  if (effectiveDate && !/^20\d{2}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error('Effective date must use YYYY-MM-DD.');

  return {
    insurerName,
    runAll,
    portalEnvironment,
    months: normalizeMonths(body.months?.length ? body.months : body.month),
    year,
    effectiveDate,
    visible: Boolean(body.visible_browser),
    finalizeAssignments: Boolean(body.finalize_assignments),
  };
}

export function buildRunnerArgs(request, { runId, backend = 'local', source = 'manual' }) {
  if (!text(runId)) throw new Error('Run id is required.');
  if (!RUN_SOURCES.has(source)) throw new Error('Unsupported run source.');
  const args = ['--run-id', text(runId), '--run-source', source, '--invocation-backend', text(backend) || 'local'];
  if (request.runAll) args.push('--all-active');
  else args.push('--insurer', request.insurerName);
  args.push('--portal-environment', request.portalEnvironment, '--month', request.months.join(','), '--year', request.year);
  if (request.effectiveDate) args.push('--effective-date', request.effectiveDate);
  if (request.visible) args.push('--visible');
  if (request.finalizeAssignments) args.push('--execute');
  return args;
}

export function startDetachedRunner(options, spawnFn) {
  const child = spawnFn(options.pythonBin, ['-u', options.scriptPath, ...(options.args || [])], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
  });
  if (typeof child.once === 'function' && typeof options.onError === 'function') {
    child.once('error', options.onError);
  }
  child.unref();
  return { status: 'queued' };
}
