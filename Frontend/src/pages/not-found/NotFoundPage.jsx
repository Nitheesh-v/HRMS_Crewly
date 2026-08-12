import { Link } from 'react-router-dom';

const NotFoundPage = () => {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h1 className="text-6xl font-extrabold text-crewly-green">404</h1>
      <p className="mt-3 text-crewly-dim">The page you are looking for does not exist.</p>
      <Link to="/" className="btn-ghost mt-6">← Back to home</Link>
    </div>
  );
};

export default NotFoundPage;