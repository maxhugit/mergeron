/** Bounded HTTP readiness through the fixed, authenticated relay. No redirects. */
import http from 'node:http';
import contract from '../../runtime/preview-profile.cjs';

// The Manager has network_mode:none. Docker executes the fixed probe inside
// its owned relay; only a fresh, bounded, structured health result is consumed.
export function relayReadiness(health, now = Date.now()) {
  const unavailable = { ready: false, httpStatus: null };
  const last = health?.Log?.at(-1);
  const end = Date.parse(last?.End);
  if (
    !Number.isFinite(end) ||
    end < now - 10000 ||
    end > now + 2000 ||
    typeof last?.Output !== 'string' ||
    last.Output.length > 256 ||
    ![0, 1].includes(last.ExitCode)
  )
    return unavailable;
  try {
    const value = JSON.parse(last.Output);
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'httpStatus,ready' ||
      typeof value.ready !== 'boolean' ||
      !(
        value.httpStatus === null ||
        (Number.isInteger(value.httpStatus) &&
          value.httpStatus >= 100 &&
          value.httpStatus <= 599)
      )
    )
      return unavailable;
    return {
      ready:
        health.Status === 'healthy' &&
        last.ExitCode === 0 &&
        value.ready &&
        value.httpStatus >= 200 &&
        value.httpStatus < 400,
      httpStatus: value.httpStatus,
    };
  } catch {
    return unavailable;
  }
}

export function probePreview({ runId, domain, path = '/', token }) {
  if (
    !contract.RUN_ID.test(runId) ||
    typeof domain !== 'string' ||
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(domain) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    return Promise.resolve({ ready: false, httpStatus: null });
  try {
    contract.profile({ path });
  } catch {
    return Promise.resolve({ ready: false, httpStatus: null });
  }
  return new Promise((resolve) => {
    let done = false;
    let deadline;
    const finish = (httpStatus = null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve({ ready: httpStatus >= 200 && httpStatus < 400, httpStatus });
    };
    const request = http.request(
      {
        hostname: `pv-${runId.replaceAll('-', '')}-relay`,
        port: 8180,
        method: 'GET',
        path,
        headers: {
          host: `${runId}.${domain}`,
          'x-mergeron-preview-transport': token,
          'cache-control': 'no-cache',
        },
      },
      (response) => {
        finish(response.statusCode ?? null);
        response.destroy(); // Never buffer a page, execute it or follow Location.
      },
    );
    request.on('error', () => finish());
    deadline = setTimeout(() => {
      finish();
      request.destroy();
    }, 900);
    deadline.unref();
    request.end();
  });
}
