import { PdfChartRenderer } from './pdf-chart.renderer';

describe('PdfChartRenderer', () => {
  let renderer: PdfChartRenderer;

  beforeAll(() => {
    renderer = new PdfChartRenderer();
  });

  it('should render a bar chart to SVG', () => {
    const svg = renderer.renderToSVG('bar', {
      xAxis: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [{ name: '销售额', data: [100, 200, 150, 300] }],
    });

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg.length).toBeGreaterThan(100);
  });

  it('should render a line chart to SVG', () => {
    const svg = renderer.renderToSVG('line', {
      xAxis: ['1月', '2月', '3月'],
      series: [{ name: '趋势', data: [10, 20, 15] }],
    });

    expect(svg).toContain('<svg');
  });

  it('should render a pie chart to SVG', () => {
    const svg = renderer.renderToSVG('pie', [
      { name: '类别A', value: 40 },
      { name: '类别B', value: 30 },
      { name: '类别C', value: 30 },
    ]);

    expect(svg).toContain('<svg');
  });

  it('should render an area chart to SVG', () => {
    const svg = renderer.renderToSVG('area', {
      xAxis: ['Mon', 'Tue', 'Wed'],
      series: [{ name: 'visits', data: [100, 200, 150] }],
    });

    expect(svg).toContain('<svg');
  });

  it('should render a stacked_bar chart to SVG', () => {
    const svg = renderer.renderToSVG('stacked_bar', {
      xAxis: ['A', 'B', 'C'],
      series: [
        { name: 'S1', data: [10, 20, 30] },
        { name: 'S2', data: [15, 25, 35] },
      ],
    });

    expect(svg).toContain('<svg');
  });

  it('should respect custom width and height', () => {
    const svg = renderer.renderToSVG('bar', {
      xAxis: ['X'],
      series: [{ data: [1] }],
    }, { width: 800, height: 500 });

    expect(svg).toContain('800');
    expect(svg).toContain('500');
  });

  it('should handle unknown chart type by falling back to bar', () => {
    const svg = renderer.renderToSVG('unknown_type', {
      xAxis: ['A', 'B'],
      series: [{ data: [1, 2] }],
    });

    expect(svg).toContain('<svg');
  });

  it('should return placeholder SVG on error', () => {
    const svg = renderer.renderToSVG('bar', null);

    expect(svg).toContain('<svg');
    // Should either render successfully or show error placeholder
  });
});
