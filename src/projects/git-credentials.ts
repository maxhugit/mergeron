/** Fixed Git credential helper: secrets stay in the child environment, never
 * command arguments or a file. Git invokes credential helpers through its
 * system shell, so this works when the temporary directory is mounted noexec.
 * Only answer reads; never persist credentials on store/erase callbacks.
 */
export const gitCredentialHelper =
  '!f() { if [ "$1" = get ]; then printf "username=%s\\npassword=%s\\n" "$MERGERON_GIT_USERNAME" "$MERGERON_GIT_TOKEN"; fi; }; f';
