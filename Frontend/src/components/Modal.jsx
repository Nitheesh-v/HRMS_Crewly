const Modal = ({ title, onClose, children }) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg"
        onClick={(e) => e.stopPropagation()} // clicks inside don't close
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-crewly-dim hover:text-crewly-text">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
};

export default Modal;