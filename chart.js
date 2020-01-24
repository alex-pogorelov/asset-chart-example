import React, { PureComponent } from 'react';
import _ from 'lodash';
import moment from 'moment';
import { Price, ShortChart } from 'components';
import {
  DEFAULT_CURRENCIES,
  PRICE_FORMAT,
  DEFAULT_BASE_ASSET,
  CHART_PRESET,
} from 'constants';

import {
  bem,
  realtimeAsset,
  convertAssetPrice,
  calculateFreeBlockPosition,
  xAxisFormat,
  yAxisFormat,
  getPeriodForDayCandles,
  getValue24,
  sortByDate,
  switchChartSize,
} from 'utils';

import { getCandles, getDayCandles } from './request';
import * as presets from './presets';
import propTypes from './propTypes';
import defaultProps from './defaultProps';
import './styles.styl';

const [USD, BTC] = DEFAULT_CURRENCIES;
const { PRICE_VOL_MIN } = CHART_PRESET;
const CHART_CONTAINER_ID = 'chart-iq-container';

const RT = realtimeAsset();

class Chart extends PureComponent {
  constructor(props) {
    super(props);
    const { chartPeriod } = props;

    this.block = bem(`chart-iq-${props.preset}`);

    this.chartInstance = null;

    this.state = {
      chartContainer: null,
      currentData: null,
      currentPeriod: chartPeriod['1M'],
      isLoading: false,
      isEmpty: false,
      studyDescriptor: null,
      mouseIn: false,
    };
  }

  componentDidMount() {
    const { asset, disableRealtime } = this.props;
    this.initChart();

    if (!disableRealtime) {
      RT.createChartSubscriber({
        id: asset.id,
        onReceive: this.onReceive,
      });
    }
  }

  componentWillUnmount() {
    const { disableRealtime } = this.props;

    if (!disableRealtime) {
      RT.removeChartSubscriber();
    }
  }

  componentDidUpdate({
    currency: prevCurrency,
    asset: prevAsset,
    preset: prevPreset,
  }) {
    const { currency, asset, preset } = this.props;
    const assetHasChanged = asset && prevAsset.id !== asset.id;

    if (prevPreset !== preset) {
      this.updatePreset();
    }

    if (currency !== prevCurrency || assetHasChanged) {
      this.getOHLCVData();
    }
  }

  updatePreset = async () => {
    const { preset, chartSettings } = this.props;
    const { chartContainer } = this.state;
    const { mainChartPreferences } = presets[preset];

    switchChartSize(mainChartPreferences(chartSettings), chartContainer);

    await this.updateState({ chartContainer });
    chartContainer.draw();
    this.calculatePopupPosition();
    this.getOHLCVData();
  };

  updateState = state => this.setState(prev => ({ ...prev, ...state }));

  calculatePopupPosition = () => {
    const { showPopup } = this.props;
    const updateComponentState = this.updateState;
    const classBlock = this.block;
    const popupMargin = 10;

    CIQ.ChartEngine.prototype.append('positionCrosshairsAtPointer', function callback() {
      const currentData = _.find(this.chart.dataSegment, { tick: this.crosshairTick });

      if (currentData) {
        updateComponentState({ currentData });
      }

      if (showPopup && $$$(`.${classBlock('popup')}`)) {
        const { offsetX, offsetY } = calculateFreeBlockPosition(
          this.cx,
          this.cy,
          $$$(`#${CHART_CONTAINER_ID}`),
          $$$(`.${classBlock('popup')}`),
          popupMargin,
        );
        $$$(`.${classBlock('popup')}`).style.top = `${offsetY}px`;
        $$$(`.${classBlock('popup')}`).style.left = `${offsetX}px`;
      }
    });
  };

  initChart = async () => {
    const {
      magnet,
      chartSettings,
      title,
      preset,
      allowScroll,
      allowZoom,
      maintainSpan,
      initData,
      stretchToFillScreen,
    } = this.props;

    const { currentPeriod, mouseIn } = this.state;

    const updateComponentState = this.updateState;

    const {
      mainChartPreferences,
      newChartCallback,
    } = presets[preset];

    this.chartInstance = new CIQ.ChartEngine({
      container: $$$(`#${CHART_CONTAINER_ID}`),
      ...mainChartPreferences(chartSettings),
    });

    this.chartInstance.dataCallback = () => {};

    this.chartInstance.allowZoom = allowZoom;
    this.chartInstance.allowScroll = allowScroll;
    this.chartInstance.maintainSpan = maintainSpan;
    this.chartInstance.calculateYAxisPositions();
    this.chartInstance.draw();

    this.chartInstance.chart.xAxis.formatter = xAxisFormat;
    this.chartInstance.chart.yAxis.priceFormatter = yAxisFormat;

    CIQ.ChartEngine.prototype.prepend('resizeChart', function prependResize() {
      if (maintainSpan && this.chart.xaxis && this.chart.xaxis.length) {
        this.cw = this.layout.candleWidth;
        this.ow = this.chart.width;
        this.s = this.chart.scroll;
      }
    });

    CIQ.ChartEngine.prototype.append('resizeChart', function appendResize() {
      if (maintainSpan && this.ow) {
        const ot = this.ow / this.cw;
        this.layout.candleWidth = this.chart.width / ot;
        this.chart.scroll = this.s;
        this.draw();
      }
    });

    function snap() {
      if (this.currentVectorParameters.vectorType) {
        return; // don't override if drawing
      }
      if (!CIQ.ChartEngine.drawingLine && !this.anyHighlighted) {
        CIQ.clearCanvas(this.chart.tempCanvas);
      }
      if (this.controls.crossX && this.controls.crossX.style.display === 'none') {
        return;
      }
      if (magnet && this.currentPanel) {
        this.magnetize();
      }
    }

    function handleMouseMove() {
      if (!mouseIn) {
        updateComponentState({ mouseIn: true });
      }
      snap.bind(this)();
    }

    CIQ.ChartEngine.prototype.append('mousemove', handleMouseMove);
    CIQ.ChartEngine.prototype.append('draw', snap);
    CIQ.ChartEngine.prototype.append('handleMouseOut', () => {
      updateComponentState({ currentData: null, mouseIn: false });
    });

    this.calculatePopupPosition();

    this.chartInstance.newChart(title, initData, null, () => {
      const {
        period,
        timeUnit,
        interval,
      } = currentPeriod;
      this.chartInstance.setPeriodicity({
        period,
        timeUnit,
        interval,
      });
      if (newChartCallback) {
        updateComponentState({ studyDescriptor: newChartCallback(this.chartInstance) });
      }
    }, {
      stretchToFillScreen,
    });

    await updateComponentState({ chartContainer: this.chartInstance });
    this.getOHLCVData();
  };

  handleChartInterval = async (chartPeriod) => {
    const { onChangeInterval } = this.props;
    const {
      period,
      timeUnit,
      interval,
    } = chartPeriod;
    const { chartContainer } = this.state;
    chartContainer.setPeriodicity({
      period,
      timeUnit,
      interval,
    });

    await this.updateState({ currentPeriod: chartPeriod });
    this.getOHLCVData();

    if (onChangeInterval) {
      onChangeInterval(chartPeriod);
    }
  };

  getOHLCVData = async () => {
    const {
      currentPeriod: {
        title: periodTitle,
        value,
      },
      chartContainer,
      studyDescriptor,
      isLoading,
    } = this.state;
    const { asset, preset } = this.props;
    const {
      newChartCallback,
    } = presets[preset];

    if (isLoading) {
      return;
    }

    if (studyDescriptor) {
      CIQ.Studies.removeStudy(chartContainer, studyDescriptor);
    }

    chartContainer.setMasterDataRender(asset.tickerSymbol, null);
    await this.updateState({ isLoading: true });
    chartContainer.fillScreen();

    try {
      const {
        data: {
          result,
        },
      } = await getCandles(value, asset.id);

      const period = getPeriodForDayCandles(periodTitle);

      const dayCandles = period
        ? await getDayCandles(period.start, period.end, asset.id)
        : null;

      const volumes = dayCandles ? dayCandles.data.result : [];

      const masterData = result.map(({
        priceBtc,
        priceUsd,
        volume,
        time,
      }) => ({
        Date: moment.utc(time).format('YYYY-MM-DD HH:mm'),
        Open: this.recalcPrice(priceBtc),
        Close: this.recalcPrice(priceBtc),
        High: this.recalcPrice(priceBtc),
        Low: this.recalcPrice(priceBtc),
        priceBtc,
        priceUsd,
        Volume: this.recalcPrice(volume),
        Volume24: this.recalcPrice(getValue24(volumes, time, volume)),
        DT: moment.utc(time).toDate(),
      }));

      chartContainer.setMasterDataRender(asset.tickerSymbol, sortByDate(masterData));
      chartContainer.fillScreen();

      this.updateState({
        isLoading: false,
        isEmpty: masterData.length === 0,
        ...(newChartCallback && { studyDescriptor: newChartCallback(chartContainer) }),
      });
    } catch (err) {
      console.log(err);
      this.updateState({ isLoading: false });
    }
  };

  onReceive = (data) => {
    const { chartContainer, isLoading } = this.state;
    const { asset } = this.props;

    chartContainer.updateChartData({
      Date: moment.unix(data.time).format('YYYY-MM-DD HH:mm'),
      DT: moment.unix(data.time).toDate(),
      Open: this.recalcPrice(data.priceBtc),
      Close: this.recalcPrice(data.priceBtc),
      High: this.recalcPrice(data.priceBtc),
      Low: this.recalcPrice(data.priceBtc),
      priceBtc: data.priceBtc,
      priceUsd: data.priceUsd,
      Volume: this.recalcPrice(data.volume),
      Volume24: (asset.volume24h || asset.volume24H),
    }, null, { fillGaps: true });


    if (!isLoading) {
      chartContainer.draw();
    }
  };

  recalcPrice = (priceBtc) => {
    const { asset, currency } = this.props;
    return DEFAULT_BASE_ASSET.id === asset.id
      ? priceBtc
      : convertAssetPrice(
        { rate: priceBtc, btcUsdRate: asset.btcUsdRate },
        currency,
        'rate',
      );
  };

  renderPrice = () => {
    const { asset, currency } = this.props;
    const { currentData } = this.state;
    const { btcUsdRate } = asset;

    return (
      currency === BTC.symbol ? (
        <React.Fragment>
          <Price
            className={this.block('usd_price')}
            amount={convertAssetPrice(
              {
                rate: currentData.High,
                btcUsdRate: asset.btcUsdRate,
              },
              USD.symbol,
              'rate',
            )}
            currency={USD.symbol}
          />
          <Price className={this.block('btc_price')} amount={currentData.Low} currency={BTC.symbol} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <Price
            className={this.block('usd_price')}
            amount={currentData.High}
            currency={USD.symbol}
          />
          {DEFAULT_BASE_ASSET.id !== asset.id && (
            <Price
              className={this.block('btc_price')}
              amount={currentData.Low * btcUsdRate}
              currency={BTC.symbol}
            />
          )}
        </React.Fragment>
      )
    );
  };

  renderVolume = (dataName) => {
    const { currency } = this.props;
    const { currentData } = this.state;

    return (
      <Price
        className={this.block('volume_price')}
        amount={currentData[dataName]}
        currency={currency}
        format={PRICE_FORMAT}
      />
    );
  };

  renderLegend = () => {
    const { asset, currency } = this.props;
    const legendLabel = currency === USD.symbol ? 'usd' : 'btc';

    return (
      <div className={this.block('legend_item', { [legendLabel]: true })}>
        <span className={this.block('symbol')}>{currency}</span>
        <Price
          className={this.block('rate')}
          amount={convertAssetPrice(asset, currency, 'rate')}
          withoutSymbol
          format={PRICE_FORMAT}
        />
      </div>
    );
  };

  renderPopup = () => {
    const { currentData } = this.state;

    return (
      <div className={this.block('popup')}>
        <div className={this.block('price')}>
          <span className={this.block('label')}>Price</span>
          { this.renderPrice() }
        </div>
        {currentData && (
          <div className={this.block('volume')}>
            <div className={this.block('volume_total')}>
              <span className={this.block('label')}>Volume</span>
              { this.renderVolume('Volume') }
            </div>
            <div className={this.block('volume_24h')}>
              <span className={this.block('label')}>Volume 24h</span>
              { this.renderVolume('Volume24') }
            </div>
          </div>
        )}
      </div>
    );
  };

  render() {
    const { preset } = this.props;

    const {
      currentPeriod,
      currentData,
      isLoading,
      isEmpty,
      mouseIn,
    } = this.state;

    const isMinView = preset === PRICE_VOL_MIN;

    return (
      <ShortChart
        handleChartInterval={this.handleChartInterval}
        isEmpty={isEmpty}
        isLoading={isLoading}
        currentPeriod={currentPeriod}
        mouseIn={mouseIn}
        currentData={currentData}
        popupBlock={this.renderPopup}
        legendBlock={this.renderLegend}
        hideFooter={isMinView}
        className={this.block('chart-labels')}
        {...this.props}
      />
    );
  }
}

Chart.defaultProps = defaultProps;
Chart.propTypes = propTypes;

export default Chart;
