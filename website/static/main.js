$(() =>{

    const hotSwap = function(page, pushSate){
        if (pushSate) {
            history.pushState(null, null, `/${  page}`);
        }
        $('.pure-menu-selected').removeClass('pure-menu-selected');
        $(`a[href="/${  page  }"]`).parent().addClass('pure-menu-selected');
        $.get('/get_page', {id: page}, (data) =>{
            $('main').html(data);
        }, 'html');
    };

    $('.hot-swapper').click(function(event){
        if (event.which !== 1) {
            return;
        }
        const pageId = $(this).attr('href').slice(1);
        hotSwap(pageId, true);
        event.preventDefault();
        return false;
    });

    window.addEventListener('load', () => {
        setTimeout(() => {
            window.addEventListener('popstate', (e) => {
                hotSwap(location.pathname.slice(1));
            });
        }, 0);
    });

    window.statsSource = new EventSource('/api/live_stats');

});
