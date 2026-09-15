'use client';

import ChartWidget from './widgets/ChartWidget';
import MetricCard from './widgets/MetricCard';

interface InlineChartProps {
  type: string;
  title: string;
  data: any;
  config?: any;
}

export default function InlineChart({ type, title, data, config }: InlineChartProps) {
  if (type === 'metric_card') {
    return (
      <div className="my-2 inline-block rounded-lg border border-gray-200 bg-white shadow-sm min-w-[200px]">
        <MetricCard title={title} data={data || {}} config={config} />
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
      <ChartWidget
        chartType={type}
        title={title}
        data={data}
        config={config}
        className="w-full h-[280px]"
      />
    </div>
  );
}
