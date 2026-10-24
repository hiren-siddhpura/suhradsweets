export function initPasswordVisibilityToggle(root = document) {
  const input = root.getElementById('password');
  const button = root.getElementById('password-visibility-toggle');
  if (!input || !button) return;

  const eye = button.querySelector('.password-eye-open');
  const eyeOff = button.querySelector('.password-eye-closed');
  button.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', String(visible));
    eye.hidden = visible;
    eyeOff.hidden = !visible;
    input.focus();
  });
}
