const Modal = ({ title, onClose, children, wide = false }) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className={`card max-h-[92vh] w-full overflow-y-auto ${wide ? 'max-w-5xl' : 'max-w-lg'}`}
        onClick={(event) => event.stopPropagation()} // clicks inside don't close
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