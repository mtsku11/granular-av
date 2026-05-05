import '@fontsource/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import GranularAVApp from './GranularAVApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GranularAVApp />
  </StrictMode>,
);
