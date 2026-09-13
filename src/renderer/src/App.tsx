/**
 * The application root.
 *
 * Everything it used to hold — the S1.3 transport smoke screen — moved to
 * Settings → Developer in S1.5, where the end-to-end specs still drive it. What
 * is left is the composition root and nothing else: the shell decides what to
 * render, and this file exists only to name it.
 */
import { AppShell } from './components/layout/app-shell'

export default function App(): React.JSX.Element {
  return <AppShell />
}
