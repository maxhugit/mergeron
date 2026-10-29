/** Bounded HTTP readiness through the fixed, authenticated relay. No redirects. */
import http from 'node:http';
import contract from '../../runtime/preview-profile.cjs';

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
