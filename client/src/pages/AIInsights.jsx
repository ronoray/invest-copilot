import { useState, useEffect } from 'react';
import { Brain, RefreshCw, TrendingUp, Shield, BarChart3, DollarSign, Globe, Calendar, Lightbulb, AlertCircle } from 'lucide-react';
import { api } from '../utils/api';

export default function AIInsights() {
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    loadLatestAnalysis();
  }, []);

  const loadLatestAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      // Your ai.js has /comprehensive-analysis endpoint
      const data = await api.get('/ai/comprehensive-analysis');
      
      if (data.success && data.analysis) {
        setAnalysis({
          text: data.analysis,
          generatedAt: data.generatedAt || new Date(),
          sectionsCount: data.sectionsCount || 10
        });
      }
    } catch (err) {
      console.error('Failed to load analysis:', err);
      setError('Failed to load AI insights. Try generating a new analysis.');
    } finally {
      setLoading(false);
    }
  };

  const generateNewAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/ai/comprehensive-analysis');
      
      if (data.success && data.analysis) {
        setAnalysis({
          text: data.analysis,
          generatedAt: data.generatedAt || new Date(),
          sectionsCount: data.sectionsCount || 10
        });
      }
    } catch (err) {
      console.error('Failed to generate analysis:', err);
      setError('Failed to generate analysis. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Parse analysis into sections
  const parseAnalysis = (text) => {
    if (!text) return [];

    const sections = [];
    const lines = text.split('\n');
    let currentSection = { title: '', content: [] };

    lines.forEach(line => {
      // Check if line is a header (starts with ##)
      if (line.trim().startsWith('##')) {
        // Save previous section if it has content
        if (currentSection.title && currentSection.content.length > 0) {
          sections.push({ ...currentSection });
        }
        // Start new section
        currentSection = {
          title: line.replace(/^##\s*/, '').trim(),
          content: []
        };
      } else if (line.trim()) {
        // Add content to current section
        currentSection.content.push(line);
      }
    });

    // Add last section
    if (currentSection.title && currentSection.content.length > 0) {
      sections.push(currentSection);
    }

    return sections;
  };

  const sections = analysis ? parseAnalysis(analysis.text) : [];

  // Get icon for each section based on title keywords
  const getSectionIcon = (title) => {
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('market')) return <TrendingUp className="w-5 h-5" />;
    if (lowerTitle.includes('divers')) return <BarChart3 className="w-5 h-5" />;
    if (lowerTitle.includes('risk')) return <Shield className="w-5 h-5" />;
    if (lowerTitle.includes('technical')) return <BarChart3 className="w-5 h-5" />;
    if (lowerTitle.includes('economic')) return <Globe className="w-5 h-5" />;
    if (lowerTitle.includes('value')) return <DollarSign className="w-5 h-5" />;
    if (lowerTitle.includes('sentiment')) return <Lightbulb className="w-5 h-5" />;
    if (lowerTitle.includes('earnings')) return <Calendar className="w-5 h-5" />;
    if (lowerTitle.includes('growth') || lowerTitle.includes('dividend')) return <TrendingUp className="w-5 h-5" />;
    if (lowerTitle.includes('global')) return <Globe className="w-5 h-5" />;
    return <Lightbulb className="w-5 h-5" />;
  };

  const getSectionColor = (index) => {
    const colors = [
      'from-blue-600 to-blue-500',
      'from-purple-600 to-purple-500',
      'from-red-600 to-red-500',
      'from-green-600 to-green-500',
      'from-amber-600 to-amber-500',
      'from-teal-600 to-teal-500',
      'from-yellow-600 to-yellow-500',
      'from-indigo-600 to-indigo-500',
      'from-pink-600 to-pink-500',
      'from-slate-600 to-slate-500',
    ];
    return colors[index % colors.length];
  };

  if (loading && !analysis) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Generating comprehensive AI analysis...</p>
          <p className="text-gray-500 text-sm mt-2">This may take 20-30 seconds</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-700 via-slate-600 to-slate-500 rounded-xl p-6 text-white shadow-xl">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold mb-2 flex items-center gap-3">
              <Brain className="w-8 h-8" />
              AI Portfolio Insights
            </h1>
            <p className="text-slate-200">10 comprehensive sections analyzing YOUR portfolio</p>
          </div>
          <button 
            onClick={generateNewAnalysis}
            disabled={loading}
            className="bg-white text-slate-700 px-6 py-3 rounded-lg font-semibold hover:bg-slate-50 transition-all flex items-center gap-2 disabled:opacity-50 shadow-lg"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Analyzing...' : 'Generate New Analysis'}
          </button>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-red-900 font-semibold">Error</p>
            <p className="text-red-700 text-sm">{error}</p>
          </div>
        </div>
      )}

      {/* Analysis Sections */}
      {sections.length > 0 && (
        <>
          {/* Metadata */}
          <div className="bg-white rounded-xl p-4 shadow-md border border-slate-200">
            <div className="flex items-center justify-between text-sm text-gray-600">
              <span>
                📊 {sections.length} sections analyzed
              </span>
              <span>
                🕒 Generated: {new Date(analysis.generatedAt).toLocaleString('en-IN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            </div>
          </div>

          {/* Sections Grid */}
          <div className="space-y-5">
            {sections.map((section, index) => (
              <div 
                key={index}
                className="bg-white rounded-xl shadow-lg border-2 border-slate-200 overflow-hidden hover:shadow-xl transition-all"
              >
                {/* Section Header */}
                <div className={`bg-gradient-to-r ${getSectionColor(index)} p-5 text-white`}>
                  <div className="flex items-center gap-3">
                    <div className="bg-white/20 p-2 rounded-lg backdrop-blur-sm">
                      {getSectionIcon(section.title)}
                    </div>
                    <div>
                      <h3 className="text-xl font-bold">{section.title}</h3>
                      <p className="text-sm opacity-90">Section {index + 1} of {sections.length}</p>
                    </div>
                  </div>
                </div>

                {/* Section Content */}
                <div className="p-6">
                  <div className="prose prose-sm max-w-none">
                    <div className="text-gray-700 leading-relaxed space-y-3">
                      {section.content.map((line, lineIndex) => {
                        // Format lines with bullet points
                        if (line.trim().startsWith('-') || line.trim().startsWith('•')) {
                          return (
                            <div key={lineIndex} className="flex items-start gap-2 ml-4">
                              <span className="text-blue-600 font-bold mt-1">•</span>
                              <span className="flex-1">{line.replace(/^[-•]\s*/, '')}</span>
                            </div>
                          );
                        }
                        // Format bold/important lines (if they contain **)
                        if (line.includes('**')) {
                          const formatted = line.split('**').map((part, i) => 
                            i % 2 === 1 ? <strong key={i}>{part}</strong> : part
                          );
                          return <p key={lineIndex} className="font-medium">{formatted}</p>;
                        }
                        // Regular line
                        return <p key={lineIndex}>{line}</p>;
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Empty State */}
      {!analysis && !loading && !error && (
        <div className="bg-gradient-to-br from-slate-50 to-slate-100 rounded-xl p-12 text-center border-2 border-slate-200 shadow-lg">
          <Brain className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-700 text-lg font-semibold mb-2">No analysis yet</p>
          <p className="text-slate-500 text-sm mb-5">
            Generate a comprehensive AI analysis covering 10 key areas of your portfolio
          </p>
          <button 
            onClick={generateNewAnalysis}
            className="bg-slate-700 hover:bg-slate-600 text-white font-semibold py-3 px-8 rounded-lg transition-all shadow-md"
          >
            Generate Analysis
          </button>
        </div>
      )}

      {/* Info Footer */}
      <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-4 text-sm">
        <p className="text-blue-900">
          <strong className="font-semibold">📅 Auto-Analysis:</strong> Comprehensive analyses are generated automatically via Telegram at 9:00 AM, 6:00 PM, and 9:00 PM IST daily. You can also generate on-demand using the button above.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4 text-sm">
        <p className="text-amber-900">
          <strong className="font-semibold">⚠️ Important:</strong> AI insights are for informational purposes only. 
          Always conduct your own research and consult a financial advisor before making investment decisions.
        </p>
      </div>
    </div>
  );
}