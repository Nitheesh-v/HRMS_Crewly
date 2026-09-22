import AppRoutes from './routes/AppRoutes.jsx';
import ChunkLoadErrorBoundary from './components/ChunkLoadErrorBoundary.jsx';

const App = () => (
  <ChunkLoadErrorBoundary>
    <AppRoutes />
  </ChunkLoadErrorBoundary>
);

export default App;
