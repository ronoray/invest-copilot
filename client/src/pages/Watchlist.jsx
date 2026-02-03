export default function Watchlist() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Watchlist</h1>
        <button className="btn btn-primary">Add Stock</button>
      </div>

      <div className="card text-center py-12">
        <p className="text-gray-500 text-lg mb-4">Your watchlist is empty</p>
        <p className="text-gray-400 text-sm mb-6">
          Add stocks you want to monitor for price alerts and signals
        </p>
        <button className="btn btn-primary">Add Your First Stock</button>
      </div>
    </div>
  );
}
