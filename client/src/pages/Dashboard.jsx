export default function Dashboard() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Dashboard</h1>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Quick Stats */}
        <div className="card">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Portfolio Value</h3>
          <p className="text-3xl font-bold text-gray-900">₹4,480.84</p>
          <p className="text-sm text-green-600 mt-1">+106.54%</p>
        </div>

        <div className="card">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Today's P&L</h3>
          <p className="text-3xl font-bold text-red-600">-₹89.88</p>
          <p className="text-sm text-red-600 mt-1">-1.97%</p>
        </div>

        <div className="card">
          <h3 className="text-sm font-medium text-gray-500 mb-2">Active Proposals</h3>
          <p className="text-3xl font-bold text-gray-900">0</p>
          <p className="text-sm text-gray-500 mt-1">Awaiting review</p>
        </div>
      </div>

      {/* Market Status */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Market Status</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-500">NSE</p>
            <p className="text-2xl font-bold">NIFTY 50: 21,456.32</p>
            <p className="text-sm text-green-600">+0.84% (+179.23)</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">Market Hours</p>
            <p className="text-lg font-semibold">9:15 AM - 3:30 PM</p>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="card">
        <h2 className="text-xl font-semibold mb-4">Recent Activity</h2>
        <p className="text-gray-500 text-center py-8">No recent activity</p>
      </div>
    </div>
  );
}
