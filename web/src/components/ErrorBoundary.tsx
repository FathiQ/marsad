import { Component, type ReactNode } from 'react'
import { RotateCcw, TriangleAlert } from 'lucide-react'

import { Button } from './ui/button'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Keeps one bad render from blanking the dashboard.
 *
 * React unmounts the entire tree when a render throws, so a single unexpected
 * value — a null where an array was promised, say — turns the whole page black
 * with no clue as to why. That is a poor failure mode for a tool someone is
 * using to answer a security question: it looks like the cluster is unreachable
 * when in fact the data arrived and one component choked on it.
 *
 * A class component because error boundaries have no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[marsad] render failed', error)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="grid h-full place-items-center bg-canvas px-6 text-center">
        <div className="max-w-lg space-y-3">
          <TriangleAlert className="mx-auto size-7 text-danger" />
          <h2 className="text-[16px] font-semibold tracking-tight">Something failed to render</h2>
          <p className="text-[13px] leading-relaxed text-muted">
            The cluster data was fetched, but the interface could not draw it. Marsad is read-only,
            so nothing has been changed and reloading is safe.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-line bg-bg p-3 text-left font-mono text-[11px] text-faint">
            {error.message}
          </pre>
          <Button variant="outline" size="md" onClick={() => this.setState({ error: null })}>
            <RotateCcw />
            Try again
          </Button>
        </div>
      </div>
    )
  }
}
