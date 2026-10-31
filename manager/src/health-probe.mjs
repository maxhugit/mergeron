import http from 'node:http';

export function probeManager({
  socketPath,
  deadlineMs = 2_000,
  client = http,
}) {
  return new Promise((resolve) => {
    let request;
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      request?.destroy();
      resolve({ healthy: reason === null, reason });
    };
    // A socket inactivity timeout does not bound connection establishment or
    // a response trickling bytes forever. Bound the entire HTTP operation.
    const deadline = setTimeout(
      () => finish('managerHealthTimeout'),
      deadlineMs,
    );
    try {
      request = client.request(
        { method: 'GET', path: '/healthz', socketPath, agent: false },
        (response) => {
          response.on('error', () => finish('managerHealthResponseError'));
          response.on('aborted', () => finish('managerHealthResponseError'));
          let bytes = 0;
          response.on('data', (data) => {
            bytes += data.length;
            if (bytes > 1024) finish('managerHealthResponseInvalid');
          });
          response.on('end', () => finish(null));
          if (response.statusCode !== 200) finish('managerHealthStatusInvalid');
          response.resume();
        },
      );
      request.on('error', () => finish('managerHealthUnavailable'));
      request.end();
    } catch {
      finish('managerHealthUnavailable');
    }
  });
}
