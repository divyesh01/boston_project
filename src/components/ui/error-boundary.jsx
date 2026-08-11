/**
 * @fileoverview Error boundary component for graceful error handling.
 * 
 * Catches JavaScript errors in child components and displays a fallback
 * UI instead of crashing the entire application.
 * 
 * @module ui/error-boundary
 * @example
 * ```jsx
 * import ErrorBoundary from "@/components/ui/error-boundary";
 * 
 * <ErrorBoundary fallback={<div>Something went wrong</div>}>
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */

import * as React from "react";

/**
 * @typedef {Object} ErrorBoundaryProps
 * @property {React.ReactNode} children - Child components to protect
 * @property {React.ReactNode} [fallback] - Custom fallback UI
 * @property {(error: Error, errorInfo: React.ErrorInfo) => void} [onError] - Error callback
 * @property {() => void} [onReset] - Reset callback to retry rendering
 */

/**
 * @typedef {Object} ErrorBoundaryState
 * @property {boolean} hasError - Whether an error has been caught
 * @property {Error | null} error - The caught error
 */

/**
 * Error boundary component.
 * 
 * Implements React's error boundary pattern to catch errors in the
 * component tree and display a graceful fallback instead of crashing.
 * 
 * @type {React.ComponentClass<ErrorBoundaryProps, ErrorBoundaryState>}
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          className="flex flex-col items-center justify-center rounded-lg border border-destructive/50 bg-destructive/5 p-8 text-center"
          role="alert"
        >
          <div className="mb-3 text-destructive">
            <svg
              className="h-10 w-10"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h3>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            An unexpected error occurred. Please try again or contact support
            if the problem persists.
          </p>
          <button
            onClick={this.handleReset}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

ErrorBoundary.displayName = "ErrorBoundary";

export default ErrorBoundary;
