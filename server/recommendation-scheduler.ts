import * as cron from 'node-cron';
import { refreshRecommendationsForUser } from './recommendation-service';

export function initializeRecommendationScheduler() {
  cron.schedule('0 4 * * *', async () => {
    console.log('[RECOMMENDATION_SCHEDULER] Starting daily recommendation refresh');
    
    try {
      const userId = 'demo-user';
      const result = await refreshRecommendationsForUser(userId);
      
      console.log(`[RECOMMENDATION_SCHEDULER] Refresh complete: ${result.imported} recommendations imported, ${result.errors} errors`);
    } catch (error) {
      console.error('[RECOMMENDATION_SCHEDULER] Error during recommendation refresh:', error);
    }
  }, {
    timezone: 'America/New_York'
  });
  
  console.log('[RECOMMENDATION_SCHEDULER] Recommendation refresh scheduler initialized - will run daily at 4:00 AM Eastern Time');
}
