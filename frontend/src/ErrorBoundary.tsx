import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-gray-900 text-white h-screen overflow-auto">
          <h1 className="text-2xl font-bold text-red-500 mb-4">
            Something went wrong.
          </h1>
          <p className="mb-2">
            The application crashed with the following error:
          </p>
          <pre className="bg-black p-4 rounded text-red-300 font-mono text-sm whitespace-pre-wrap">
            {this.state.error && this.state.error.toString()}
          </pre>
          <p className="mt-4 mb-2">Component Stack:</p>
          <pre className="bg-black p-4 rounded text-gray-400 font-mono text-xs whitespace-pre-wrap">
            {this.state.errorInfo && this.state.errorInfo.componentStack}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
