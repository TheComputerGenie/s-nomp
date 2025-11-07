$(() => {
    $('.hot-swapper').click(function (event) {
        if (event.which !== 1) return;
        const pageId = $(this).attr('href').slice(1);
        window.location.href = `/${pageId}`;
        event.preventDefault();
        return false;
    });

    // Initial EventSource connection
    window.statsSource = new EventSource('/api/live_stats');
});
