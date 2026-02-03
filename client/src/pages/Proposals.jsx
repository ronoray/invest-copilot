export default function Proposals() {
  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">AI Proposals</h1>
        <div className="flex gap-2">
          <button className="btn btn-secondary">Pending</button>
          <button className="btn btn-secondary">Approved</button>
          <button className="btn btn-secondary">Rejected</button>
        </div>
      </div>

      <div className="card text-center py-12">
        <div className="mb-4">
          <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <span className="text-3xl">💡</span>
          </div>
          <p className="text-gray-500 text-lg mb-2">No proposals yet</p>
          <p className="text-gray-400 text-sm">
            The AI will scan the market and generate buy/sell recommendations
          </p>
        </div>
        
        <div className="max-w-md mx-auto mt-6 p-4 bg-blue-50 rounded-lg">
          <p className="text-sm text-blue-800">
            <strong>Coming soon:</strong> AI-powered market scanning that identifies
            opportunities based on technical and fundamental analysis
          </p>
        </div>
      </div>
    </div>
  );
}
