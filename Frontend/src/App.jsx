import AppRoutes from './routes/AppRoutes.jsx';
import AppToaster from './components/AppToaster.jsx';
import ChunkLoadErrorBoundary from './components/ChunkLoadErrorBoundary.jsx';

const App = () => (
  <ChunkLoadErrorBoundary>
    <AppRoutes />

    {/* 35.1 — the app-wide toast host; see Frontend/src/components/AppToaster.jsx */}
    <AppToaster />
  </ChunkLoadErrorBoundary>
);

export default App;
