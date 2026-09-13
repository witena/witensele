import { APP_NAME } from '@shared/version'

export default function App(): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-base font-sans select-none">
      <h1 className="text-4xl font-medium tracking-[0.3em] text-fg">{APP_NAME}</h1>
    </div>
  )
}
