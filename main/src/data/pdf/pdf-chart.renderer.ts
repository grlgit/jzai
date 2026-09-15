import { Injectable, Logger } from '@nestjs/common';

/**
 * Server-side chart rendering using ECharts SSR → SVG → PNG.
 */
@Injectable()
export class PdfChartRenderer {
  private readonly logger = new Logger(PdfChartRenderer.name);

  /**
   * Render a chart to PNG buffer (for embedding in pdf-lib).
   */
  async renderToPNG(
    chartType: string,
    data: any,
    options?: { title?: string; width?: number; height?: number; colors?: string[] },
  ): Promise<Buffer> {
    const svg = this.renderToSVG(chartType, data, options);
    const sharp = require('sharp');
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  /**
   * Render a chart to SVG string using ECharts SSR mode.
   */
  renderToSVG(
    chartType: string,
    data: any,
    options?: { title?: string; width?: number; height?: number; colors?: string[] },
  ): string {
    const echarts = require('echarts');
    const width = options?.width || 500;
    const height = options?.height || 300;

    const chart = echarts.init(null, null, {
      renderer: 'svg',
      ssr: true,
      width,
      height,
    });

    try {
      const echartsOption = this.buildOption(chartType, data, options);
      chart.setOption(echartsOption);
      return chart.renderToSVGString();
    } catch (err: any) {
      this.logger.error(`Chart render failed: ${err.message}`);
      // Return a placeholder SVG with error text
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="#f5f5f5" rx="4"/>
        <text x="50%" y="50%" text-anchor="middle" fill="#999" font-size="14">图表渲染失败</text>
      </svg>`;
    } finally {
      chart.dispose();
    }
  }

  private buildOption(chartType: string, data: any, options?: any): any {
    const colors = options?.colors || ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    const title = options?.title ? { text: options.title, left: 'center', textStyle: { fontSize: 14, color: '#333' } } : undefined;

    switch (chartType) {
      case 'pie':
        return {
          title,
          color: colors,
          tooltip: { trigger: 'item' },
          series: [{
            type: 'pie',
            radius: '65%',
            data: Array.isArray(data) ? data : (data.series || data.data || []),
            label: { formatter: '{b}: {d}%' },
          }],
        };

      case 'bar':
      case 'stacked_bar': {
        const xAxis = data.xAxis || data.categories || [];
        const series = Array.isArray(data.series) ? data.series : [{ data: data.values || data.data || [] }];
        return {
          title,
          color: colors,
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: xAxis, axisLabel: { rotate: xAxis.length > 8 ? 30 : 0 } },
          yAxis: { type: 'value' },
          grid: { left: '10%', right: '5%', bottom: '15%', top: title ? '15%' : '10%' },
          series: series.map((s: any) => ({
            type: 'bar',
            name: s.name || '',
            data: s.data || s.values || [],
            stack: chartType === 'stacked_bar' ? 'total' : undefined,
          })),
        };
      }

      case 'line':
      case 'area': {
        const xAxis = data.xAxis || data.categories || [];
        const series = Array.isArray(data.series) ? data.series : [{ data: data.values || data.data || [] }];
        return {
          title,
          color: colors,
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: xAxis, axisLabel: { rotate: xAxis.length > 8 ? 30 : 0 } },
          yAxis: { type: 'value' },
          grid: { left: '10%', right: '5%', bottom: '15%', top: title ? '15%' : '10%' },
          series: series.map((s: any) => ({
            type: 'line',
            name: s.name || '',
            data: s.data || s.values || [],
            smooth: true,
            areaStyle: chartType === 'area' ? { opacity: 0.3 } : undefined,
          })),
        };
      }

      default:
        this.logger.warn(`Unknown chart type: ${chartType}, falling back to bar`);
        return this.buildOption('bar', data, options);
    }
  }
}
