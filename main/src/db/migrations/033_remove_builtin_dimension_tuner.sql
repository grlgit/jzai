-- Remove the built-in dimensionTuner panel now that it is provided by the dimension-tuner app package.
DELETE FROM jz_user_sidebar WHERE panel_id = 'dimensionTuner';
DELETE FROM jz_panels WHERE id = 'dimensionTuner' AND category = 'builtin';
