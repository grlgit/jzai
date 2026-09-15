import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard')
  getDashboard() {
    return this.analytics.getDashboard();
  }

  @Get('efficiency')
  getEfficiencyDashboard() {
    return this.analytics.getEfficiencyDashboard();
  }

  @Get('user/:userId')
  getUserDetail(@Param('userId') userId: string) {
    return this.analytics.getUserDetail(userId);
  }

  @Post('feedback')
  submitFeedback(@Body() body: { messageId: string; userId?: string; rating: 'up' | 'down'; reason?: string }) {
    this.analytics.recordFeedback({
      messageId: body.messageId,
      userId: body.userId || 'anonymous',
      rating: body.rating,
      reason: body.reason,
    });
    return { success: true };
  }
}
