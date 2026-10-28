/** Read-only CLI: request ingress is the authenticated command-completed event. */
export const PROJECT_TOOL_CLIENT = String.raw`import base64, json, re, sys, time, uuid
from pathlib import Path

def validate(value):
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value.get('requestId', '')):
        raise ValueError('A stable requestId is required')
    return value

mode, argument = sys.argv[1:]
if mode == '--encode':
    value = json.loads(argument)
    value.setdefault('requestId', uuid.uuid4().hex)
    payload = json.dumps(validate(value), ensure_ascii=False).encode()
    if len(payload) > 32768:
        raise ValueError('Request too large')
    print(base64.urlsafe_b64encode(payload).decode().rstrip('='))
elif mode == '--request':
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,43692}={0,2}', argument):
        raise ValueError('Invalid encoded request')
    value = validate(json.loads(base64.urlsafe_b64decode(argument + '=' * (-len(argument) % 4))))
    print(json.dumps({'requestId': value['requestId'], 'status': 'submitted'}))
elif mode == '--result':
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', argument):
        raise ValueError('Invalid requestId')
    target = Path(__file__).resolve().parent / ('project-tool-' + argument + '-result.json')
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            result = json.loads(target.read_text())
            if result.get('requestId') == argument:
                print(json.dumps(result, ensure_ascii=False))
                sys.exit(0 if result.get('status') == 'ok' else 1)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        time.sleep(0.2)
    print(json.dumps({'requestId': argument, 'status': 'unconfirmed', 'message': 'Inspect the manager or retry with the SAME requestId and payload; never claim success.'}))
    sys.exit(2)
else:
    raise ValueError('Use --encode, --request or --result')
`;

/** No shell interpretation: compound commands and indirect paths fail closed. */
export function projectToolCommand(
  command: string,
  helper: string,
): Record<string, unknown> | null {
  const prefixes = [
    `python3 "${helper}" --request `,
    `python3 '${helper}' --request `,
    `python3 ${helper} --request `,
  ];
  const prefix = prefixes.find((value) => command.startsWith(value));
  if (!prefix) return null;
  const encoded = command.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{1,43692}={0,2}$/.test(encoded)) return null;
  try {
    const payload = Buffer.from(encoded, 'base64url');
    if (payload.length > 32768) return null;
    const value: unknown = JSON.parse(payload.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const input = value as Record<string, unknown>;
    if (
      typeof input.requestId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)
    )
      return null;
    return input;
  } catch {
    return null;
  }
}
