import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Suppress benign ResizeObserver errors that occur during layout recalculations
const suppressResizeObserverError = () => {
  const oldOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    if (typeof message === 'string' && message.includes('ResizeObserver')) {
      return true; // Prevents the browser from reporting the error
    }
    if (oldOnError) {
      return oldOnError(message, source, lineno, colno, error);
    }
    return false;
  };
};

suppressResizeObserverError();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

