import React from "react";
import styled from 'styled-components'
import { useSelector, useDispatch } from 'react-redux';
import { Box, themeGet } from '@primer/react';
import { Banner } from '@primer/react/experimental';
import { withTranslation } from "react-i18next";
import { clearSelectedFiles } from 'Redux/components/files/filesSlice';

const MultiFileActionContainer = styled(Box)`
  position: absolute;
  display: flex;
  width: 100%;
  height: 100%;
  pointer-events: none;
  flex-direction: column;
  justify-content: flex-end;
  z-index: 1;

  & > * {
    align-self: center;
  }
`;

const MultiFileActionBanner = styled(Banner)`
  pointer-events: auto;
  margin-bottom: ${themeGet('space.2')};

  & > .BannerContainer {
    flex-direction: column;
  }
`;

function MultiFileAction(props) {
  const dispatch = useDispatch();
  const selectedFiles = useSelector((state) => state.files.selectedFiles);
  const files = useSelector((state) => state.files.list);

  const { t } = props;
  return (
    <MultiFileActionContainer>
      <MultiFileActionBanner
        variant="info"
        title={`${t("Selected files")}: ${selectedFiles.length}`}
        secondaryAction={(
          <Banner.PrimaryAction
            variant="danger"
            onClick={() => {
              const batch = files
                .filter(f => selectedFiles.includes(f.path) && f.lock)
                .map(f => f.rawPath);
              document.dispatchEvent(new CustomEvent('unlock-batch', { detail: batch }));
            }}
          >
            {t("Unlock all")}
          </Banner.PrimaryAction>
        )}
        primaryAction={(
          <Banner.PrimaryAction
            variant="outline"
            onClick={() => {
              const batch = files
                .filter(f => selectedFiles.includes(f.path) && !f.lock)
                .map(f => f.rawPath);
              document.dispatchEvent(new CustomEvent('lock-batch', { detail: batch }));
            }}
          >
            {t("Lock all")}
          </Banner.PrimaryAction>
        )}
        onDismiss={() => {
          dispatch(clearSelectedFiles());
        }}
      />
    </MultiFileActionContainer>
  );
}

export default withTranslation()(MultiFileAction);